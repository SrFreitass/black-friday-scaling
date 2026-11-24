# 4. Métricas da aplicação: latência por rota

> Rascunho de documentação do processo, para virar seção do artigo.
> Estado registrado em 2026-11-24.

## 4.1 Por que instrumentar a aplicação

O `stub_status` do Nginx (seção 2.4) fornece apenas contagens: com ele se
calcula requisições por segundo, mas não o **tempo de resposta**, que o
enunciado também pede. Além disso, o Nginx vê "uma requisição", sem saber qual
operação da loja ela representa.

A própria API sabe o que o proxy não sabe:

- **qual rota** foi chamada (`GET /products` ou `POST /orders`). Os testes de
  ruptura mostraram capacidades bem diferentes para leitura (~1100 req/s) e
  compra (~600 req/s), diferença que uma métrica agregada esconderia;
- **qual status** foi devolvido (200, 400, 500);
- **quanto tempo** levou para processar.

Diferente do Nginx, a API é código próprio: em vez de um exporter, ela expõe
diretamente uma rota `/metrics` no formato do Prometheus (instrumentação
direta, também no modelo pull).

## 4.2 Biblioteca

| Componente | Pacote | Versão |
|---|---|---|
| Cliente Prometheus para JavaScript | `prom-client` | 15.1.3 |

Também foi avaliado o `fastify-metrics` (15.0.1), um plugin do Fastify
construído sobre o `prom-client`. Ele gera as mesmas métricas, mas seus padrões
precisariam ser alterados: cria também um *summary* (que não pode ser agregado
entre réplicas, seção 4.7), mede a própria rota `/metrics` e ignora rotas
inexistentes. Optou-se pela implementação manual, de cerca de 25 linhas, que
deixa explícito como a medição acontece.

## 4.3 Implementação

`server/src/config/metrics.ts`:

```ts
import type { FastifyInstance } from "fastify";
import client from "prom-client"

client.collectDefaultMetrics();

const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ["method", "route", "status_code"],
})

function registerMetrics(app: FastifyInstance) {
    app.addHook('onResponse', async (req, reply) => {
        const route = req.routeOptions.url ?? 'unmatched';
        if(route === '/metrics') return;

        httpRequestDuration
            .labels(req.method, route, String(reply.statusCode))
            .observe(reply.elapsedTime / 1000)
    });

    app.get(
        '/metrics',
        async (_req, reply) => {
            reply.header("content-type", client.register.contentType);
            return client.register.metrics();
        }
    )
}

export { registerMetrics };
```

Em `server/src/config/server.ts`, a função é chamada logo após criar a
instância do Fastify e antes das rotas da loja:

```ts
const app = fastify();
registerMetrics(app);
```

### O histograma

O histograma é criado uma única vez, no carregamento do módulo. Ele não guarda
cada requisição: guarda **contadores por faixa de tempo** (*buckets*). Cada
observação incrementa todas as faixas cujo limite superior (`le`, *less or
equal*) é maior ou igual ao valor observado, ou seja, as faixas são
**cumulativas**. Junto com elas, o histograma mantém `_count` (total de
observações) e `_sum` (soma dos valores). O custo de memória é fixo,
independentemente do número de requisições.

| Propriedade | Valor | Motivo |
|---|---|---|
| `name` | `http_request_duration_seconds` | convenção do Prometheus: unidade base (segundos) e unidade como sufixo |
| `labelNames` | `method`, `route`, `status_code` | cada combinação vira uma série; permite separar leitura de compra e sucesso de erro |
| `buckets` | padrão da biblioteca | ver abaixo |

Não foi criado um contador separado de requisições: o `_count` do histograma já
é esse contador, e o req/s por rota é `rate(http_request_duration_seconds_count[1m])`.

### Buckets

Foram usados os limites padrão:

```
0,005  0,01  0,025  0,05  0,1  0,25  0,5  1  2,5  5  10   (segundos)
```

Esse conjunto não é definido pelo servidor Prometheus, e sim pelas bibliotecas
cliente. O `client_golang`, cliente oficial do Prometheus, define a constante
`DefBuckets` para "medir de forma ampla o tempo de resposta (em segundos) de um
serviço de rede", e o README do `prom-client` afirma que os limites padrão são
"destinados a cobrir requisições web/RPC usuais".

O conjunto inclui o limite de **0,5 s, igual ao SLO adotado**. Segundo a
documentação do Prometheus (*Histograms and summaries*, seção *Bucketing*), a
fração de requisições dentro de um limite só é calculada com exatidão se
existir um bucket exatamente nesse limite:

```promql
sum(rate(http_request_duration_seconds_bucket{le="0.5"}[1m]))
  / sum(rate(http_request_duration_seconds_count[1m]))
```

**Limitação:** a API em repouso responde em 2–4 ms (medido nos testes de
ruptura), abaixo do menor limite padrão (5 ms). Essas requisições ficam todas
no mesmo bucket, e o percentil estimado nessa região tem erro de até 5 ms, já
que, segundo a mesma documentação, o erro do percentil é limitado pela largura
do bucket em que ele cai. Para a análise de saturação, em que a latência sobe
para centenas de milissegundos, a resolução padrão é suficiente.

Os buckets devem ser escolhidos antes da coleta: mudá-los depois gera séries
com limites diferentes, que não podem ser combinadas nas consultas.

### O hook `onResponse`

O Fastify chama o hook `onResponse` depois que cada resposta é enviada, para
todas as rotas, sem alterar nenhuma delas. Nesse momento:

| Dado | Origem | Observação |
|---|---|---|
| método | `req.method` | |
| rota | `req.routeOptions.url` | o **molde** da rota (`/orders`), e não a URL real (`/orders?page=2`) |
| status | `reply.statusCode` | convertido para texto: labels são sempre strings |
| tempo | `reply.elapsedTime` | em milissegundos, dividido por 1000 |

**Cardinalidade:** uma URL que não corresponde a nenhuma rota chega com
`routeOptions.url` indefinido e é registrada como `unmatched`. Se a URL real
fosse usada como label, cada caminho aleatório (de um robô varrendo o site, por
exemplo) criaria uma série nova, até esgotar a memória do Prometheus.

A rota `/metrics` é excluída do histograma: as coletas periódicas do Prometheus
não são tráfego de usuários.

### O que o tempo medido inclui

`reply.elapsedTime` mede do momento em que o Fastify recebe a requisição até a
resposta ser entregue ao sistema operacional. Para a API, o cliente é o Nginx.

| Inclui | Não inclui |
|---|---|
| roteamento e leitura do corpo JSON | handshake TCP e rede entre cliente e Nginx |
| validação | tempo dentro do Nginx e rede até a API |
| consultas ao banco, incluindo a espera por uma conexão do pool | espera no buffer do socket até o *event loop* pegar a requisição |
| serialização e escrita da resposta | |

A última linha é importante sob carga: com a API saturada, as requisições
esperam **antes** de o relógio do Fastify começar. A API pode registrar poucos
milissegundos de processamento enquanto o cliente espera centenas. A diferença
entre a latência medida pelo k6 (cliente) e a medida pela API é o tempo gasto
em filas e na rede, fora da aplicação.

Os handlers das rotas não usam `await` nos controllers: cada camada repassa a
*Promise* do banco, e o Fastify a espera antes de responder. Como o
`onResponse` só dispara depois disso, o tempo do banco está dentro do intervalo
medido.

### A rota `/metrics`

`client.register` é o **registro padrão**: toda métrica criada se inscreve nele
automaticamente. `register.metrics()` gera o texto de todas as métricas
inscritas, e `register.contentType` informa em que formato esse texto foi
gerado:

```
text/plain; version=0.0.4; charset=utf-8
```

O cabeçalho vem do registro porque cada registro pode gerar um formato
diferente (o mesmo registro configurado para OpenMetrics informa
`application/openmetrics-text; version=1.0.0`). Lendo os dois do mesmo objeto,
o cabeçalho sempre corresponde ao corpo.

O Prometheus 3 é rígido quanto a esse cabeçalho. Num teste com a versão
v3.16.0 coletando o mesmo conteúdo com cabeçalhos diferentes:

| Content-Type | Resultado |
|---|---|
| `text/plain; version=0.0.4; charset=utf-8` | coletado |
| `text/plain; charset=utf-8` | coletado |
| `application/json; charset=utf-8` | **recusado**: *received unsupported Content-Type ... and no fallback_scrape_protocol specified* |

Até a versão 2, o Prometheus assumia o formato de texto quando o cabeçalho era
desconhecido; a partir da 3, a coleta falha. É um exemplo de negociação de
conteúdo do HTTP: o Prometheus envia um cabeçalho `Accept` com os formatos que
aceita, e o servidor responde com o `Content-Type` do formato escolhido.

## 4.4 Métricas padrão do processo

`collectDefaultMetrics()` registra métricas do processo e do runtime. A
biblioteca foi feita para Node.js (motor V8), e a API roda em Bun (motor
JavaScriptCore). Teste do que funciona:

| Métrica | No Bun | Uso no projeto |
|---|---|---|
| `process_cpu_seconds_total` | funciona | CPU **por réplica**, comparável ao limite de 0,5 CPU (o que o Node Exporter não mostra) |
| `process_resident_memory_bytes` | funciona | memória real, comparável ao limite de 256 MB (aviso antes de um *OOMKill*) |
| `process_open_fds` | funciona | descritores abertos; cada conexão TCP ocupa um |
| `nodejs_eventloop_lag_seconds` | funciona | atraso do *event loop*: sinal da fila dentro do processo |
| `nodejs_heap_size_used_bytes` | funciona | |
| `nodejs_heap_space_*` | quase tudo zero | "espaços" do heap do V8, inexistentes no JavaScriptCore |
| `nodejs_gc_duration_seconds` | sem dados | |
| `nodejs_version_info` | informa `v26.3.0` | versão do Node com que o Bun se declara compatível, não a do Bun (1.4.5) |

As métricas `process_*` seguem uma convenção do Prometheus adotada pelos
clientes de várias linguagens (Go, Python, Java), e por isso independem do
runtime.

O *event loop lag* é a métrica mais relevante do grupo: o JavaScript executa o
código numa única thread, e o atraso mede quanto uma tarefa espera na fila até
ser executada. Em repouso, o p99 medido foi de 0,2 ms.

## 4.5 Proteção da rota `/metrics`

O Nginx repassa tudo de `location /` para a API, o que deixaria `/metrics`
acessível a qualquer cliente. Um `location` de correspondência exata, que tem
prioridade sobre o `location /`, bloqueia o acesso externo:

```nginx
location = /metrics {
    return 404;
}
```

O Prometheus acessa a API diretamente pela rede interna do Docker, sem passar
pelo Nginx.

## 4.6 Coleta com várias réplicas: descoberta por DNS

Com `static_configs` e o alvo `api:8080`, o Prometheus trataria todas as
réplicas como **um único alvo**: a cada coleta, conectaria num IP qualquer
devolvido pelo DNS, e contadores de processos diferentes se alternariam na
mesma série, tornando o `rate()` sem sentido.

O job da API usa descoberta de serviço por DNS:

```yaml
- job_name: api
  dns_sd_configs:
    - names: ["api"]
      type: A
      port: 8080
      refresh_interval: 10s
```

| Propriedade | Função |
|---|---|
| `names` | nome consultado no DNS interno do Docker |
| `type: A` | tipo de registro DNS pedido: nome para endereço IPv4. Cada réplica devolve um registro A |
| `port` | o registro A só contém o IP; a porta é informada na configuração (um registro SRV traria também a porta) |
| `refresh_interval` | intervalo entre consultas ao DNS |

O Prometheus cria **um alvo por IP**, e cada réplica vira uma série própria,
identificada pelo label `instance`.

O intervalo de 10 s é o mesmo do `resolver ... valid=10s` do Nginx (seção 2.3):
o DNS é consultado de novo a cada 10 s pelos dois componentes, abaixo do
intervalo de coleta de 15 s, de modo que uma réplica nova passa a receber
tráfego e a ser coletada antes da coleta seguinte. O valor padrão do
Prometheus seria 30 s.

O mesmo mecanismo, o DNS como registro de serviços, aparece no Nginx e no
Prometheus. No Kubernetes, o equivalente é o `kubernetes_sd_configs`, que
consulta a API do cluster.

## 4.7 Agregação entre réplicas

Cada réplica mantém seus próprios contadores, em memória. A soma acontece na
consulta:

```promql
sum(rate(http_request_duration_seconds_count{job="api"}[1m]))
sum by (instance) (rate(http_request_duration_seconds_count{job="api"}[1m]))
```

A primeira dá as requisições por segundo do sistema; a segunda, de cada
réplica (para verificar o balanceamento).

Duas regras de ordem:

1. **`rate()` antes de `sum()`.** Quando uma réplica reinicia, só o contador
   dela volta a zero; o `rate()` aplicado série a série trata esse *reset*.
   Somando antes, a queda de uma réplica aparece como queda do total, e o
   `rate()` produz picos falsos.
2. **Percentis não se calculam por média.** O p95 do sistema não é a média dos
   p95 das réplicas. Somam-se os buckets de todas as réplicas e calcula-se o
   percentil uma vez:

   ```promql
   histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="api"}[1m])))
   ```

   É o motivo para usar histograma e não *summary*: o *summary* calcula o
   percentil dentro de cada processo, e o resultado não pode ser agregado.

Conferência entre camadas: `rate(nginx_http_requests_total)` deve ser próximo
de `sum(rate(http_request_duration_seconds_count))`. Uma divergência indica
requisições perdidas entre o Nginx e a API.

## 4.8 Validação

Após o rebuild da API e uma execução do teste de fumaça do k6 (35/35
verificações aprovadas):

| Verificação | Resultado |
|---|---|
| alvos no Prometheus | `api` (172.20.0.4:8080), `nginx`, `node` e `prometheus`, todos UP |
| `/metrics` acessado de fora, pela porta 80 | 404 (bloqueado pelo Nginx) |
| séries do job `api` | 124 |
| memória da réplica | 66,6 MB, de um limite de 256 MB |
| requisições dentro do SLO (`le="0.5"` ÷ `_count`) | 100 % |

Contagem por rota após o teste de fumaça (5 iterações):

```
GET  /products  200  = 5
GET  /orders    200  = 5
POST /orders    200  = 5
POST /orders    400  = 5    (pedido inválido, esperado pelo teste)
```

O label `instance` é o IP da réplica. Ao recriar o contêiner, o Docker reaproveitou
o mesmo IP, e as séries continuaram com o mesmo `instance`; o `rate()` tratou a
volta dos contadores a zero como *reset*.

## 4.9 Problemas encontrados

1. **Rota duplicada.** A rota `/metrics` foi movida para `metrics.ts` sem ser
   removida de `server.ts`. O TypeScript não acusou erro (as duas chamadas são
   válidas para o compilador), mas o Fastify recusa rotas duplicadas na
   inicialização (`FST_ERR_DUPLICATED_ROUTE`) e a API não subiria. A verificação
   de tipos não substitui executar a aplicação.
2. **Encapsulamento de plugins do Fastify.** Implementar as métricas como plugin
   (`app.register(plugin)`) foi considerado. Em teste, o hook criado dentro de
   um plugin não mediu as rotas declaradas fora dele: cada `register` cria um
   contexto isolado. Seria necessário o pacote `fastify-plugin` para desligar o
   isolamento; sem ele, o histograma ficaria vazio sem nenhum erro. A versão
   final usa uma função comum que recebe a instância do Fastify.

## 4.10 Uso nos testes

- **Várias réplicas:** com 4 réplicas, o job `api` passou a ter 4 alvos (seção 6).
- **Sob carga:** CPU, memória, *event loop lag* e fração no SLO foram medidos na Black
  Friday (seções 5 e 6). Os percentis vêm do k6, porque os *buckets* padrão são largos
  acima de 1 s (seção 5.4).
