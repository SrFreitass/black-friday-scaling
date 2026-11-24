# 2. Nginx: porta de entrada, balanceador e fonte de métricas

> Rascunho de documentação do processo, para virar seção do artigo.
> Estado registrado em 2026-11-24.

## 2.1 Papel do Nginx na arquitetura

Até aqui, o cliente falava direto com a API. Com o Nginx, ele passa a ser o
**único ponto de entrada** do sistema:

```
cliente (navegador / k6)
      │  porta 80 (única porta publicada)
      ▼
    Nginx ──► api:8080 ──► db:5432
      │
      └── porta 8080 interna: /stub_status (métricas, só na rede do Docker)
```

O Nginx cumpre três funções:

1. **Proxy reverso:** recebe as requisições dos clientes e as repassa para a
   API. A API deixa de publicar porta e só é alcançável pela rede interna do
   Docker.
2. **Balanceador de carga:** quando a API tiver várias réplicas, distribui as
   requisições entre elas.
3. **Fonte de métricas:** expõe contadores de conexões e requisições pelo
   módulo `stub_status`, que serão coletados pelo Prometheus (seção 3).

| Componente | Imagem | Versão |
|---|---|---|
| Nginx | `nginx` (oficial) | 1.31.9 |

## 2.2 Configuração final

Arquivo `nginx/nginx.conf`. A pasta `nginx/` inteira é montada no contêiner em
`/etc/nginx/conf.d/`:

```nginx
upstream load_balancer {
    least_conn;
    zone api 64k;
    resolver 127.0.0.11 valid=10s ipv6=off;
    server api:8080 resolve;
}

server {
    listen 80;

    location / {
        proxy_pass http://load_balancer;
    }

    location = /metrics {
        return 404;
    }
}

server {
    listen 8080;

    location /stub_status {
        stub_status;
        access_log off;
    }
}
```

O arquivo tem três blocos no mesmo nível, todos dentro do contexto `http` do
`nginx.conf` principal da imagem (que inclui `conf.d/*.conf`):

| Bloco | Responsabilidade |
|---|---|
| `upstream load_balancer` | **para onde** mandar o tráfego da loja (o grupo de réplicas da API) |
| `server` na porta 80 | a loja, aberta para os clientes |
| `server` na porta 8080 | a página de status, só para a rede interna |

Duas diretivas foram adicionadas depois das primeiras versões:

| Diretiva | Motivo | Seção |
|---|---|---|
| `least_conn` | com round-robin, algumas réplicas saturavam enquanto outras ficavam livres | 6 |
| `location = /metrics { return 404; }` | a API passou a expor métricas em `/metrics`, que não devem ficar acessíveis de fora. O `=` é correspondência exata e tem prioridade sobre o `location /` | 4.5 |

### Por que substituir o `default.conf`

A imagem oficial já traz um `/etc/nginx/conf.d/default.conf` com um `server`
na porta 80 que serve arquivos HTML estáticos. Se a configuração da loja for
adicionada **ao lado** dele, existem dois `server` na mesma porta, e o Nginx
escolhe qual atende cada requisição comparando o cabeçalho `Host` com o
`server_name` (*virtual hosting*). Como o `default.conf` declara
`server_name localhost`, ele vencia as requisições para `localhost`, e a loja
nunca era alcançada.

A solução final monta a **pasta** `nginx/` sobre `/etc/nginx/conf.d/`. Um bind
mount não mistura conteúdos: ele **esconde** o que havia no destino e mostra só
o que vem do host. O `default.conf` da imagem fica invisível, e o único `server`
na porta 80 passa a ser o da loja.

| | Bind de **arquivo** (primeira versão) | Bind de **pasta** (versão final) |
|---|---|---|
| Como elimina o `default.conf` | o arquivo precisa ser montado **com o mesmo nome** | a pasta inteira é substituída; o nome do arquivo é livre |
| Editar o arquivo no host | quebra o bind no Docker Desktop (problema 6, seção 2.6) | funciona: a pasta continua a mesma |
| Arquivos adicionais | um bind por arquivo | basta criar outro `.conf` na pasta |

Verificação em contêineres descartáveis: sem o bind, `/etc/nginx/conf.d/`
contém `default.conf`; com a pasta montada, contém apenas `nginx.conf`, e
`nginx -T` não mostra nenhum `server` servindo `/usr/share/nginx/html`.

### Alterações no Docker Compose

```yaml
nginx:
  image: nginx:1.31.9
  volumes:
    - ./nginx:/etc/nginx/conf.d:ro
  ports:
    - 80:80
  depends_on:
    - api
api:
  # sem "ports": a API só é alcançável pela rede interna
```

O `:ro` monta a pasta como somente leitura: o Nginx só lê a configuração.

A remoção do `ports` da API tem dois motivos: obrigar todo o tráfego a passar
pelo Nginx e permitir várias réplicas (três contêineres não podem publicar a
mesma porta do host).

## 2.3 Balanceamento de carga e descoberta das réplicas

### Como o Nginx encontra a API

Dentro da rede do Compose, cada serviço é alcançável pelo **nome**: o Docker
mantém um servidor DNS interno, no endereço `127.0.0.11` de cada contêiner, que
traduz `api` para o IP do contêiner. Com várias réplicas
(`docker compose up --scale api=3`), o mesmo nome responde com **um IP por
réplica**, e o Nginx cria uma entrada no grupo para cada IP.

### Descoberta dinâmica

Por padrão, o Nginx resolve os nomes **uma única vez**, ao carregar a
configuração. Réplicas criadas depois disso não recebem tráfego até um
`nginx -s reload`. Para acompanhar réplicas que surgem e desaparecem, o bloco
`upstream` usa três diretivas (disponíveis no Nginx de código aberto desde a
versão 1.27.3):

| Diretiva | Função |
|---|---|
| `zone api 64k` | guarda a lista de servidores em **memória compartilhada** entre os processos *worker* do Nginx, para que ela possa ser atualizada em tempo de execução. 64 KB é o tamanho usado nos exemplos da documentação e comporta dezenas de servidores |
| `resolver 127.0.0.11 valid=10s ipv6=off` | consulta o DNS interno do Docker e **repete a consulta a cada 10 s**; `ipv6=off` porque a rede do Compose não usa IPv6 |
| `server api:8080 resolve` | marca o nome `api` para ser resolvido de novo periodicamente |

O valor `valid=10s` é uma escolha de projeto, não um padrão: ele foi mantido
**abaixo do intervalo de coleta do Prometheus (15 s, seção 3)**, para que uma
réplica nova entre no balanceamento antes da coleta seguinte. Um valor menor
detecta réplicas mais rápido, ao custo de mais consultas DNS.

Esse mecanismo é uma forma de **descoberta de serviço** (*service discovery*)
via DNS, a mesma ideia que o Kubernetes resolve com o objeto *Service* e que o
Prometheus usa para descobrir alvos de coleta.

Um efeito colateral útil: com `resolve`, o Nginx inicia mesmo que a API ainda
não exista. Sem ele, um nome que não resolve na inicialização impede o Nginx de
subir (`host not found in upstream`).

### Pré-requisito: aplicação sem estado

Distribuir requisições entre réplicas só é correto porque a API é **stateless**:
nenhuma informação do cliente fica na memória do processo, tudo vai para o
PostgreSQL. Se a API guardasse, por exemplo, um carrinho em memória, a
requisição seguinte poderia cair em outra réplica e o carrinho "sumiria".

### Métodos de balanceamento

Sem diretiva explícita, o Nginx usa **round-robin**. Os métodos disponíveis no
Nginx de código aberto:

| Método | Critério | Adequado quando |
|---|---|---|
| round-robin (padrão) | uma réplica de cada vez, em ordem | réplicas iguais e requisições de custo parecido |
| `least_conn` | a réplica com menos conexões ativas | requisições de duração muito diferente |
| `ip_hash` | hash do IP do cliente (sessão "grudada") | aplicações que guardam sessão em memória |
| `hash <chave>` | hash de um valor qualquer (URL, cabeçalho) | cache distribuído |
| `random two least_conn` | sorteia duas e escolhe a menos ocupada | vários balanceadores na frente das mesmas réplicas |

Depois dos testes com 4 réplicas (seção 6), o `upstream` passou a usar
`least_conn`: com round-robin, algumas réplicas saturavam enquanto outras
ficavam livres.

### Como o `least_conn` decide

O round-robin reveza as réplicas numa ordem fixa, sem olhar a situação de
nenhuma delas:

```
req 1 → A    req 2 → B    req 3 → C    req 4 → D    req 5 → A ...
```

O `least_conn`, antes de cada requisição, consulta quantas conexões estão em
andamento com cada réplica e escolhe a de menor número (em caso de empate,
reveza entre as empatadas):

```
conexões abertas agora:   A = 12   B = 3   C = 40   D = 5
próxima requisição → B
```

O número de conexões abertas funciona como medida de carga porque uma conexão
só é liberada quando a réplica termina de responder. Uma requisição que fica
esperando uma consulta ao banco, uma vez livre no pool de conexões ou o próprio
*event loop* mantém a conexão aberta durante toda a espera. Uma réplica rápida
fecha suas conexões logo e mantém o número baixo; uma réplica atrasada acumula
conexões. O round-robin não enxerga essa diferença e continua entregando a
mesma fatia à réplica atrasada. O `least_conn` cria um ciclo de correção:
quanto mais uma réplica atrasa, mais conexões acumula e menos requisições novas
recebe.

Duas observações:

- **Conexões não são CPU.** O critério conta requisições em andamento, não o
  esforço de cada uma. Numa API em que cada requisição ocupa uma conexão até
  ser respondida, as duas medidas andam juntas.
- **A contagem precisa ser compartilhada.** O Nginx roda vários processos
  *worker*; sem a diretiva `zone`, cada um contaria apenas as conexões que ele
  mesmo abriu. Com `zone api 64k`, a contagem fica em memória compartilhada, e
  todos decidem com o mesmo número.

Nos testes da seção 6, em sobrecarga, os descritores abertos por réplica variaram
de 50 a 1.433 com round-robin e ficaram próximos entre si com `least_conn` em cada
execução (por exemplo, 404 a 417). O pior tempo de resposta mediano caiu de 4,39 s
para 1,45 s, enquanto a mediana subiu de 2,1 ms para 323 ms. Com folga, os dois
métodos foram equivalentes: o `least_conn` distribui a espera, não cria capacidade.

O `ip_hash` seria inadequado neste experimento: todo o tráfego do k6 sai da
mesma máquina, ou seja, do mesmo IP, e cairia sempre na mesma réplica. O mesmo
acontece em produção com milhares de clientes atrás de um mesmo NAT de
operadora.

## 2.4 `stub_status`: as métricas do Nginx

O módulo `stub_status` gera uma página de texto com contadores do servidor.
Ela foi colocada num `server` separado, na porta 8080, que **não** está no
`ports` do Compose: só contêineres da rede interna a alcançam. A segurança fica
por conta da rede, sem depender de listas de IP (`allow`/`deny`). O
`access_log off` evita que as consultas periódicas do coletor poluam o log de
acesso.

A porta 8080 e o caminho `/stub_status` seguem o padrão do
nginx-prometheus-exporter, que procura o status em
`http://127.0.0.1:8080/stub_status` quando nenhum endereço é informado. Não há
conflito com a porta 8080 da API: cada contêiner tem as suas próprias portas.

Saída real, coletada de dentro do contêiner:

```
Active connections: 2
server accepts handled requests
 2 2 33
Reading: 0 Writing: 1 Waiting: 1
```

| Campo | Significado | Tipo |
|---|---|---|
| `Active connections` | conexões de clientes abertas agora | instantâneo |
| `accepts` | conexões aceitas desde o início | acumulado |
| `handled` | conexões tratadas (menor que `accepts` só se algum limite de recursos for atingido) | acumulado |
| `requests` | requisições HTTP recebidas desde o início | acumulado |
| `Reading` | conexões em que o Nginx está lendo o cabeçalho da requisição | instantâneo |
| `Writing` | conexões em que o Nginx está escrevendo a resposta | instantâneo |
| `Waiting` | conexões ociosas, abertas à espera da próxima requisição | instantâneo |

**Keep-alive visível nos números:** foram **33 requisições em apenas 2
conexões**. Com HTTP keep-alive, o cliente (aqui, o exporter) reaproveita a
mesma conexão TCP para várias requisições, em vez de fazer um *handshake* a
cada uma. A conexão em `Waiting` é justamente essa conexão reaproveitada,
parada entre uma coleta e outra.

O `stub_status` **não fornece tempo de resposta**, apenas contagens. Com ele é
possível calcular requisições por segundo, mas não latência (ver seção 3.8).

## 2.5 Validação

Com o Nginx na frente, o teste de fumaça do k6 foi executado contra a porta 80
(`k6 run -e BASE_URL=http://localhost src/tests/smoke.ts`): **35 de 35
verificações aprovadas**, 0 falhas. O fluxo completo (catálogo, compra, pedido
inválido, listagem) funciona através do proxy.

## 2.6 Problemas encontrados durante a configuração

1. **Arquivo montado sobre uma pasta.** O bind `./nginx.conf:/etc/nginx/conf.d/`
   tentou montar um arquivo no lugar de um diretório; o contêiner nem iniciou
   (`not a directory`). Os dois lados do bind precisam ser do mesmo tipo.
2. **Página padrão em vez da loja.** Com o arquivo montado ao lado do
   `default.conf`, o `server` da imagem atendia as requisições e procurava
   arquivos em `/usr/share/nginx/html` (seção 2.2).
3. **Barra dupla na URL.** Com `location /api` e `proxy_pass http://api:8080/;`,
   o Nginx substitui o prefixo `/api` pela `/` do `proxy_pass`, e
   `/api/products` chegava à API como `//products` (404). A versão final usa
   `location /` e `proxy_pass` sem caminho, repassando a URL intacta.
4. **`upstream` dentro de `server`.** O Nginx recusou a configuração
   (`"upstream" directive is not allowed here`): o `upstream` só é permitido no
   contexto `http`. A documentação de cada diretiva informa onde ela pode
   aparecer, na linha *Context*.
5. **`stub_status` no mesmo `location` do `proxy_pass`.** Os dois são
   geradores de resposta e um anula o outro. A solução foi o `server` separado.
6. **Bind de arquivo único no Docker Desktop (WSL).** Depois de editar o
   `nginx.conf`, o contêiner não subia (`no such file or directory`): o bind
   fica preso ao arquivo original, e editores que salvam gravando um arquivo
   novo quebram a referência. Recriar o contêiner resolve
   (`docker compose up -d --force-recreate nginx`). A correção definitiva foi
   mover a configuração para a pasta `nginx/` e montar a pasta em vez do
   arquivo (seção 2.2).

## 2.7 Pendências

- ~~Testar com várias réplicas~~: feito na seção 6. Com 4 réplicas, 400
  requisições se dividiram em exatamente 100 por réplica, contadas pela métrica
  da própria API (`sum by (instance)`).
- **Repetir o teste de ponto de ruptura através do Nginx** e comparar com a
  capacidade medida direto na API.
- ~~Conexão nova com a API por requisição~~: hipótese descartada por medição. O
  Nginx 1.31.9 usa HTTP/1.1 com a API e reaproveita conexões: 200 requisições
  sequenciais abriram só 12 conexões novas na API (contador `PassiveOpens` do
  kernel, que inclui as coletas do Prometheus).
- **Cabeçalhos `X-Forwarded-For` / `X-Real-IP`** para que a API conheça o IP
  real do cliente (hoje ela vê o IP do Nginx). Não afeta as métricas.
