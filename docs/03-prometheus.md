# 3. Prometheus: coleta contínua de métricas (modelo pull)

> Rascunho de documentação do processo, para virar seção do artigo.
> Estado registrado em 2026-11-24.

## 3.1 Visão geral

```
                         rede interna do Docker Compose
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Nginx:8080/stub_status ◄── lê ── nginx-prometheus-exporter:9113 ◄─┐ │
│                                                                    │ │
│  /proc do kernel ◄──────── lê ── node-exporter:9100 ◄──────────────┤ │
│                                                                    │ │
│                                   Prometheus:9090 ── pull a cada 15s │
│                                        │                             │
└────────────────────────────────────────┼─────────────────────────────┘
                                         │ porta 9090 publicada
                                         ▼
                              UI nativa no navegador
```

| Componente | Imagem | Versão | Porta |
|---|---|---|---|
| Prometheus | `prom/prometheus` | v3.16.0 | 9090 (publicada) |
| Exporter do Nginx | `nginx/nginx-prometheus-exporter` | 1.5.3 | 9113 (interna) |
| Node Exporter | `prom/node-exporter` | v1.13.1 | 9100 (interna) |

As portas 9090, 9100 e 9113 são as reservadas para cada componente na lista
*Default port allocations* mantida pela comunidade do Prometheus.

Todas as versões foram fixadas. A tag `latest` não significa "a mais nova":
no Docker Hub, a `latest` do exporter do Nginx apontava para a 1.5.0, de
outubro de 2025, enquanto a versão mais recente era a 1.5.3.

## 3.2 O modelo pull

No modelo **pull**, é o Prometheus que inicia a conexão: a cada intervalo, ele
faz `GET /metrics` em cada alvo configurado e armazena o resultado. Os alvos
não sabem que o Prometheus existe; apenas mantêm uma página de métricas
atualizada.

| | Pull (usado aqui) | Push |
|---|---|---|
| Quem inicia a conexão | o Prometheus | o alvo |
| Detecta alvo fora do ar? | sim: a coleta falha e a série `up` vale 0 | não: silêncio é ambíguo |
| Quem controla o ritmo | o Prometheus | o alvo (pode sobrecarregar o servidor) |
| Alvo precisa conhecer o servidor? | não | sim |
| Alvo atrás de NAT ou firewall | difícil: o Prometheus não o alcança | fácil: o alvo é quem abre a conexão |
| Processo de vida curta | os dados se perdem entre coletas | adequado |

O Prometheus também aceita dados empurrados, para os casos em que o pull não
funciona: o **Pushgateway** (intermediário para *jobs* curtos, que o
Prometheus continua coletando por pull), o receptor de **remote write**
(desligado por padrão) e o receptor **OTLP** (OpenTelemetry). Neste trabalho,
o k6, que só existe enquanto o teste roda, é o caso típico de push (seção de
testes de carga).

## 3.3 Exporters: tradutores de formato

O Prometheus entende um único formato de texto:

```
# HELP nginx_http_requests_total Total http requests
# TYPE nginx_http_requests_total counter
nginx_http_requests_total 33
```

Sistemas que não falam esse formato, como o Nginx e o kernel Linux, precisam
de um **exporter**: um processo que lê os dados no formato original e os
publica no formato do Prometheus. O exporter não guarda estado: a cada coleta,
lê a fonte naquele instante, traduz e responde.

Esse padrão permite **observar um sistema sem modificá-lo**. O Nginx de código
aberto só oferece o `stub_status`; alternativas que eliminariam o exporter
(NGINX Plus, módulos de terceiros como o `nginx-module-vts`, OpenResty com Lua)
exigem a versão paga ou uma compilação customizada do Nginx.

Cada exporter roda no seu próprio contêiner (um processo por contêiner): se
ele falhar, o Nginx continua atendendo a loja, e cada um pode ser atualizado
separadamente. No Kubernetes, o mesmo exporter rodaria como *sidecar*, um
segundo contêiner dentro do pod do Nginx.

## 3.4 Exporter do Nginx

```yaml
nginx-prometheus-exporter:
  image: nginx/nginx-prometheus-exporter:1.5.3
  command: ["--nginx.scrape-uri", "http://nginx:8080/stub_status"]
  depends_on:
    - nginx
```

O argumento `--nginx.scrape-uri` aponta para o `stub_status` usando o **nome do
serviço** (`nginx`), resolvido pelo DNS do Docker. Sem ele, o exporter
procuraria em `127.0.0.1`, que é o próprio contêiner do exporter, e reportaria
`nginx_up 0`.

Métricas publicadas:

| Métrica | Tipo | Origem no `stub_status` |
|---|---|---|
| `nginx_http_requests_total` | counter | `requests` |
| `nginx_connections_accepted` | counter | `accepts` |
| `nginx_connections_handled` | counter | `handled` |
| `nginx_connections_active` | gauge | `Active connections` |
| `nginx_connections_reading` / `writing` / `waiting` | gauge | `Reading` / `Writing` / `Waiting` |
| `nginx_up` | gauge | 1 se a leitura do `stub_status` funcionou |

**Counter e gauge:**

- um **counter** só cresce, desde o início do processo. O valor absoluto diz
  pouco; o que interessa é a **velocidade** com que cresce, calculada pela
  função `rate()`. Requisições por segundo = `rate(nginx_http_requests_total[...])`.
- um **gauge** sobe e desce e representa um valor **instantâneo**. Aplicar
  `rate()` a um gauge não faz sentido.

Quando o Nginx reinicia, os counters voltam a zero. O `rate()` detecta a queda
como um *reset* e não produz taxas negativas.

As próprias coletas do exporter também contam como requisições no Nginx.
Com uma coleta a cada 15 s, o efeito é desprezível perto do tráfego do teste,
mas ilustra que **medir interfere no que é medido**.

## 3.5 Node Exporter

O Node Exporter coleta métricas da **máquina**: CPU, memória, disco e rede. Ele
as lê nos arquivos que o kernel Linux expõe em `/proc` e `/sys`
(`/proc/stat`, `/proc/meminfo`, `/proc/net/dev` etc.).

```yaml
node-exporter:
  image: prom/node-exporter:v1.13.1
```

### Escolha da forma de execução

O README oficial recomenda rodar o Node Exporter com a rede e o `/` do host.
No ambiente deste trabalho (Docker Desktop sobre WSL2), três formas foram
testadas em contêineres descartáveis:

| Forma | Resultado |
|---|---|
| A) contêiner comum, sem montagens | funciona |
| B) montando `/proc` e `/sys` do host | falha: o exporter não encontra `/host/proc/self` e encerra; o Docker Desktop não repassa o `/proc` do WSL |
| C) `network_mode: host` e `pid: host` (README oficial) | inicia, mas fica inalcançável: o *host networking* não está ativo no Docker Desktop |

Foi adotada a forma A. O que ela enxerga depende de como o kernel isola os
contêineres com **namespaces**:

| Métrica | Arquivo | Isolado por namespace? | O que o Node Exporter mostra |
|---|---|---|---|
| CPU | `/proc/stat` | não | a máquina inteira: **12 CPUs** (threads) |
| Memória | `/proc/meminfo` | não | a máquina inteira: **11,6 GiB** |
| Rede | `/proc/net/dev` | sim (*network namespace*) | só as interfaces do próprio contêiner (`eth0`, `lo`) |

Os valores de CPU e memória coincidem com os do WSL (`nproc` = 12,
`free` = 11.906 MiB). Ou seja, o "nó" observado é a **máquina virtual do
WSL2** onde o Docker Desktop executa todos os contêineres.

**Limitações para o artigo:**

- **A rede da máquina não aparece.** O *network namespace* dá a cada contêiner
  as suas próprias interfaces, e o exporter só vê as dele. No Kubernetes, o
  Node Exporter roda como *DaemonSet* (um pod por nó) com `hostNetwork`, e as
  interfaces do nó ficam visíveis.
- **A CPU da máquina não revela a saturação da API.** A API está limitada a 0,5
  de 12 CPUs, ou seja, cerca de **4,2 %** da máquina. Mesmo com a API no
  limite, o Node Exporter mostra a máquina quase ociosa. Para decidir quando
  escalar, é preciso medir também por contêiner (cAdvisor, embutido no
  Kubernetes) e na própria aplicação.

## 3.6 Configuração do Prometheus

### `prometheus.yml` (escrito à mão)

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]

  - job_name: nginx
    static_configs:
      - targets: ["nginx-prometheus-exporter:9113"]

  - job_name: node
    static_configs:
      - targets: ["node-exporter:9100"]
```

| Propriedade | Função |
|---|---|
| `global` | valores padrão para todos os *jobs* |
| `scrape_interval` | intervalo entre coletas, ou seja, a frequência de amostragem |
| `scrape_configs` | lista de *jobs*: o que coletar |
| `job_name` | nome de um grupo de alvos do mesmo tipo |
| `static_configs.targets` | lista fixa de endereços `host:porta`; o caminho padrão é `/metrics` |

O *job* `prometheus` usa `localhost` porque o alvo é o próprio processo, dentro
do mesmo contêiner. Os outros usam o nome do serviço, porque estão em outros
contêineres.

**Labels automáticos:** toda série coletada recebe `job` (o `job_name`) e
`instance` (o alvo):

```
nginx_http_requests_total{job="nginx", instance="nginx-prometheus-exporter:9113"}
```

**`static_configs` e descoberta de serviço:** no Compose, os nomes dos alvos
são fixos e podem ser escritos à mão. No Kubernetes, os pods surgem e somem
com IPs novos; ali se usa `kubernetes_sd_configs`, e o Prometheus consulta a
API do Kubernetes para descobrir os alvos, a mesma ideia do `resolve` no Nginx.

### Por que 15 segundos

O intervalo foi **derivado** da menor janela de análise:

1. A decisão de escalar usa `rate()` sobre **1 minuto**: o pico simulado dura
   3 minutos, e uma janela de 10 minutos só reagiria depois do fim do pico.
2. O `rate()` precisa de no mínimo **2 amostras** na janela (uma inclinação
   exige dois pontos). A recomendação da comunidade é de pelo menos **4×** o
   intervalo de coleta, margem que tolera a perda de uma coleta e o
   desalinhamento entre a janela da consulta e os instantes de coleta
   (Brazil, *Robust Perception*; Rabenstein, *Grafana Labs*, que tornou a
   regra padrão na variável `$__rate_interval` do Grafana).
3. Logo: **60 s ÷ 4 = 15 s**.

Verificações: a janela de 10 minutos pedida no enunciado terá 600 ÷ 15 = **40
amostras**; e 15 s é o valor do arquivo de exemplo distribuído com o próprio
Prometheus (o padrão interno, sem configuração, é 1 minuto).

### Contêiner do Prometheus

```yaml
prometheus:
  image: prom/prometheus:v3.16.0
  ports:
    - 9090:9090
  volumes:
    - ./prometheus:/etc/prometheus:ro
    - prometheus-data:/prometheus

volumes:
  prometheus-data:
```

| Montagem | Tipo | Motivo |
|---|---|---|
| `./prometheus` → `/etc/prometheus` | bind de **pasta**, somente leitura | a configuração é escrita à mão no projeto; montar a pasta evita o problema do bind de arquivo único no WSL (seção 2.6) |
| `prometheus-data` → `/prometheus` | **volume nomeado** | os dados da TSDB sobrevivem à recriação do contêiner |

O processo do Prometheus roda como o usuário `nobody` (uid 65534), e não como
root. Uma pasta do projeto pertenceria ao usuário do host (uid 1000), e o
Prometheus falharia ao gravar (`permission denied`). O volume nomeado, na
primeira criação, copia o conteúdo **e o dono** da pasta da imagem, que já
pertence ao `nobody`.

| | Bind (`./pasta:/caminho`) | Volume nomeado (`nome:/caminho`) |
|---|---|---|
| Onde fica | uma pasta do projeto | área gerenciada pelo Docker |
| Edição direta | sim | não |
| Dono dos arquivos | o usuário do host | herdado da imagem |
| Uso típico | configuração escrita à mão | dados gerados pelo serviço |

Cuidado: `docker compose down -v` apaga os volumes nomeados e, com eles, todo
o histórico de métricas.

## 3.7 Como o Prometheus armazena os dados (TSDB)

O Prometheus guarda tudo numa **TSDB** (*time series database*) própria.

**Série temporal:** uma série é identificada pelo **nome da métrica mais o
conjunto de labels**. Cada combinação diferente é uma série separada:

```
nginx_http_requests_total{job="nginx", instance="nginx-prometheus-exporter:9113"}
└──────── nome ─────────┘└────────────────── labels ─────────────────────────┘
```

Cada série é uma sequência de **amostras**, pares (timestamp em milissegundos,
valor em ponto flutuante de 64 bits):

```
(1795520800507, 33) → (1795520815507, 35) → (1795520830507, 38) → ...
```

**Caminho de uma amostra:**

1. **Head block (memória):** as amostras recentes ficam em memória, agrupadas em
   *chunks* por série.
2. **WAL (*write-ahead log*):** toda amostra também é gravada em sequência num
   log em disco. Se o processo cair, o head é reconstruído a partir do WAL.
3. **Blocos persistentes:** a cada 2 horas, o conteúdo do head é gravado em
   disco como um **bloco** imutável, com os *chunks* e um **índice invertido**
   (de cada par label=valor para as séries que o contêm), que permite filtrar
   por labels rapidamente.
4. **Compactação:** blocos pequenos são combinados em blocos maiores ao longo
   do tempo.
5. **Retenção:** blocos mais antigos que o prazo de retenção são apagados
   (padrão: **15 dias**, confirmado na instância deste trabalho).

As amostras são comprimidas com a técnica do Gorilla (Facebook): timestamps
como diferença de diferenças (*delta-of-delta*), que com coletas regulares é
quase sempre zero, e valores por XOR com o valor anterior, que é pequeno
quando o valor muda pouco.

**Números medidos na instância deste trabalho** (3 *jobs*, coleta a cada 15 s):

| Medida | Valor | Fonte |
|---|---|---|
| Séries ativas | 1.756 | `prometheus_tsdb_head_series` |
| Séries por *job* | prometheus 929, node 765, nginx 62 | `count by (job) ({__name__=~".+"})` |
| Taxa de ingestão | ≈ 117 amostras/s | `rate(prometheus_tsdb_head_samples_appended_total[1m])` |
| Conferência | (929 + 765 + 62) ÷ 15 s ≈ 117 amostras/s | séries ÷ intervalo |

A conferência mostra a relação direta entre o número de séries, o intervalo
de coleta e o volume de dados. Por isso, labels com muitos valores possíveis
(ID de usuário, URL completa) são evitados: cada valor novo cria uma série nova
(**cardinalidade**).

Referências: documentação do Prometheus, *Storage*; Fabian Reinartz, *Writing
a Time Series Database from Scratch* (2017); Pelkonen et al., *Gorilla: A Fast,
Scalable, In-Memory Time Series Database* (VLDB, 2015).

## 3.8 Validação

Em `http://localhost:9090/targets`, os três alvos aparecem como **UP**:

| job | instance | duração da coleta |
|---|---|---|
| `nginx` | `nginx-prometheus-exporter:9113` | 3,6 ms |
| `node` | `node-exporter:9100` | 26,3 ms |
| `prometheus` | `localhost:9090` | 8,3 ms |

A validação de sintaxe é feita com a ferramenta que acompanha a imagem:

```
promtool check config /etc/prometheus/prometheus.yml
 SUCCESS: /etc/prometheus/prometheus.yml is valid prometheus config file syntax
```

Para aplicar mudanças no `prometheus.yml` sem recriar o contêiner, basta
enviar o sinal SIGHUP ao processo (`docker compose kill -s SIGHUP prometheus`).

## 3.9 Três camadas de observação

As métricas coletadas respondem perguntas diferentes, e só o cruzamento delas
permite um diagnóstico:

| Camada | Fonte | Pergunta | Método |
|---|---|---|---|
| Borda | Nginx (`stub_status`) | quanto tráfego está chegando? | RED (*Rate, Errors, Duration*), Tom Wilkie |
| Aplicação | API (`/metrics`) | como a API está atendendo? | RED |
| Infraestrutura | Node Exporter | a máquina aguenta? | USE (*Utilization, Saturation, Errors*), Brendan Gregg |

### Os métodos RED e USE

As métricas foram escolhidas e organizadas segundo dois métodos
complementares, que funcionam como listas do que medir.

**RED** (Tom Wilkie, 2018) se aplica a **serviços**, tudo o que atende
requisições, e descreve o ponto de vista de quem usa o serviço:

| Letra | Pergunta | Métrica neste trabalho |
|---|---|---|
| **R**ate (taxa) | quantas requisições estão sendo atendidas? | `rate(nginx_http_requests_total[1m])` e `rate(http_request_duration_seconds_count[1m])` |
| **E**rrors (erros) | quantas falham? | requisições com status 5xx; `http_req_failed` no k6 |
| **D**uration (duração) | quanto tempo levam? | `histogram_quantile(0.95, ...)` sobre `http_request_duration_seconds_bucket` |

**USE** (Brendan Gregg, 2012) se aplica a **recursos**, aquilo que é consumido
para atender (CPU, memória, disco, rede), e descreve o estado do recurso:

| Letra | Pergunta | Métrica neste trabalho |
|---|---|---|
| **U**tilization (utilização) | que fração do tempo o recurso está ocupado? | CPU da réplica, `rate(process_cpu_seconds_total[1m])` (limite: 0,5 núcleo); CPU da máquina, pelo Node Exporter |
| **S**aturation (saturação) | há trabalho esperando pelo recurso? | conexões abertas na réplica (`process_open_fds`, limite superior das requisições em andamento) e atraso do *event loop* (`nodejs_eventloop_lag_seconds`) |
| **E**rrors (erros) | o recurso está falhando? | processo encerrado por falta de memória (*OOMKilled*) |

A distinção entre utilização e saturação é central: um recurso pode estar 100 %
ocupado sem ninguém esperando por ele, e o serviço continua rápido. A espera,
e portanto a latência sentida pelo cliente, começa quando há **saturação**: o
recurso está ocupado e o trabalho se acumula numa fila. É a mesma distinção
da teoria de filas entre utilização (ρ) e tamanho da fila.

Os dois métodos se complementam no diagnóstico: **o RED mostra que há um
problema, e o USE indica qual recurso o causa.** No teste de Black Friday com
uma réplica (seção 5):

1. **RED, o sintoma:** a duração disparou (p95 de 1,55 s na navegação e 3,06 s na
   compra) e a taxa parou de crescer em 919 req/s, embora a demanda fosse de
   2.826 req/s. Os erros ficaram em 0 %: a API não falhou, ficou lenta.
2. **USE, a causa:** a CPU da réplica ficou cravada em 0,5 núcleo (utilização
   no limite), com 1.431 descritores abertos e o *event loop* atrasado
   (saturação). A CPU da máquina ficou em 19 %: o recurso esgotado era o limite
   da réplica, e não a máquina.

O diagnóstico aponta a ação: há espaço na máquina para mais réplicas, o que foi
testado na seção 6.

Referências: Tom Wilkie, *The RED Method: How to Instrument Your Services*
(Grafana Labs, 2018); Brendan Gregg, *The USE Method* (2012).

**A camada da aplicação.** O `stub_status` só fornece contagens: com ele se
obtém requisições por segundo, mas **não o tempo de resposta**, que o enunciado
também pede. As opções avaliadas:

| Opção | Fonte da latência | Observação |
|---|---|---|
| Instrumentar a API (`prom-client`) | histograma de duração por rota em `/metrics` | modelo pull; padrão da indústria |
| Exporter de log do Nginx | `$request_time` do log de acesso | métrica do Nginx, mas exige mais um contêiner |
| k6 via remote write | latência medida pelo cliente | modelo push; complemento, não fonte principal |

Foi adotada a instrumentação da API, descrita na seção 4.

## 3.10 Problemas encontrados

1. **Tag da imagem sem o `v`.** `prom/prometheus:3.16.0` não existe; o projeto
   usa o formato `v3.16.0`. Cada projeto define o formato das suas tags (o
   Nginx usa `1.31.9`, sem prefixo).
2. **Serviço indentado dentro de outro.** Com 4 espaços, o `prometheus:` virou
   uma propriedade do serviço `api`, e o Compose recusou o arquivo inteiro
   (`services.api.prometheus`). No YAML, a indentação define a hierarquia.
3. **`prometheus.yml` vazio.** O Prometheus subiu sem erro com o arquivo vazio,
   mas sem coletar nada. A página `/targets` vazia foi o sinal.
4. **Node Exporter com `/proc` do host.** A montagem recomendada para servidores
   Linux não funciona no Docker Desktop (seção 3.5).

## 3.11 A consulta do enunciado

A taxa de crescimento dos acessos HTTP nos últimos 10 minutos foi calculada na UI
nativa durante a Black Friday simulada (seção 5, Figuras 5.1 e 5.2):

```promql
rate(nginx_http_requests_total[10m])
```
