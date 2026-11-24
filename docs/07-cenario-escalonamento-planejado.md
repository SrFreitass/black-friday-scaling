# 7. Cenário 1: escalonamento planejado para a Black Friday

> Rascunho de documentação do processo, para virar seção do artigo.
> Este cenário organiza os resultados das seções 5 e 6 numa narrativa de
> planejamento de capacidade. Os números vêm dos testes; as premissas de
> negócio estão marcadas como tal.

## 7.1 A situação

Uma loja virtual sabe que a Black Friday vai trazer muito mais visitantes que
um dia comum. **Premissa:** a partir de sinais externos, como menções em redes
sociais, campanhas de marketing e o histórico de anos anteriores, a loja estima
que, à meia-noite, a demanda vai saltar para **10 vezes** o tráfego normal.

| Grandeza | Valor | Origem |
|---|---|---|
| Tráfego normal | 283 req/s | premissa do teste: 30 % da capacidade estimada de uma réplica |
| Pico previsto | 2.826 req/s | premissa: ~10× o tráfego normal (3× a capacidade estimada de uma réplica) |
| Duração do pico | 3 min | premissa do teste |

Como o pico é **previsível**, a loja pode se preparar **antes**: aumentar o
número de réplicas com antecedência (escalonamento planejado, ou
pré-escalonamento), em vez de esperar o tráfego chegar.

## 7.2 O planejamento

### Passo 1: medir a capacidade de uma réplica

Testes de ruptura (*breakpoint*) com uma réplica limitada a 0,5 CPU e 256 MB,
acessada diretamente (sem o Nginx):

| Operação | Capacidade |
|---|---|
| Navegação (`GET /products`) | 1.100 req/s |
| Compra (`POST /orders`) | 600 req/s |
| Tráfego misto (80 % / 20 %) | 942 req/s, por 1 ÷ (0,8 ÷ 1100 + 0,2 ÷ 600) |

### Passo 2: calcular o número de réplicas

```
réplicas mínimas = pico ÷ capacidade por réplica = 2.826 ÷ 942 = 3,0
```

Três réplicas operariam exatamente no limite, sem nenhuma folga. A teoria de
filas mostra que a latência dispara antes de a utilização chegar a 100 %
(seção 5). Com **4 réplicas**, a utilização estimada no pico seria:

```
utilização = 2.826 ÷ (4 × 942) = 75 %
```

uma margem de 25 % sobre a estimativa. **Decisão:** escalar de 1 para 4
réplicas antes da Black Friday.

```bash
docker compose up -d --scale api=4
```

O Nginx e o Prometheus descobrem as réplicas novas sozinhos, pelo DNS
(seção 6.2).

## 7.3 A validação: a Black Friday simulada

Antes do dia real, a loja simula o evento com o teste de carga (seções 5 e 6).

| | Planejado | Medido com 4 réplicas |
|---|---|---|
| Capacidade do sistema | 3.768 req/s | **1.685–2.173 req/s** |
| Capacidade por réplica | 942 req/s | **421–543 req/s** |
| Utilização no pico | 75 % | acima de 100 % |
| Requisições dentro do SLO | ~100 % | **2,6–71,5 %**, conforme o balanceamento |
| Visitantes descartados | 0 | **122–212 mil** |

Escalar **ajudou muito**: comparado com uma réplica, o sistema atendeu de 2,2 a
2,8 vezes mais requisições, e os descartes caíram de 410 mil para 122–212 mil.
Mas **o planejamento não bastou**: a capacidade real ficou em 45–58 % da
estimada.

## 7.4 Por que a estimativa errou

A capacidade foi medida em condições diferentes das reais:

| Na medição (breakpoint) | Na Black Friday simulada |
|---|---|
| 1 réplica sozinha na máquina | 4 réplicas, PostgreSQL, Nginx e k6 disputando os mesmos 12 núcleos |
| acesso direto à API | todo o tráfego passa pelo Nginx |
| poucas dezenas de conexões | ~1.400 conexões simultâneas |
| 10 conexões com o banco | até 40 conexões com o banco |

Mesmo uma única réplica, atrás do Nginx e sob a carga da Black Friday,
sustentou ~640 req/s (seção 5), e não os 942 estimados. Com 4 réplicas, cada
uma sustentou menos ainda: o crescimento não é linear quando há recursos
compartilhados.

**Lição de planejamento:** a capacidade precisa ser medida **na configuração
real**, com o mesmo caminho de rede, o mesmo número de réplicas e a mesma
concorrência. Um *breakpoint* de uma réplica isolada dá um limite superior
otimista.

## 7.5 Quantas réplicas seriam necessárias

Refazendo a conta com a capacidade **medida** por réplica (~420–540 req/s com 4
réplicas):

```
réplicas mínimas  = 2.826 ÷ 420 ≈ 7
com utilização de 75 % = 2.826 ÷ (420 × 0,75) ≈ 9
```

Estes valores são **estimativas não testadas**, e esbarram em dois limites:

1. **O crescimento sublinear deve continuar.** Mais réplicas disputando a mesma
   máquina e o mesmo banco tendem a render menos cada uma.
2. **O banco tem um teto de conexões.** Cada réplica abre até 10 conexões (pool
   padrão do `pg`), e o PostgreSQL aceita 100 por padrão (`max_connections`).
   Com 9 réplicas, seriam até 90 conexões, perto do limite. Daí em diante,
   escalar a API exigiria mudar o banco (pool compartilhado, réplicas de
   leitura), o que fica fora do escopo deste trabalho.

## 7.6 Intervenção manual guiada pelo Prometheus

Mesmo sem nenhuma automação, as métricas coletadas já permitem que a equipe de
operação **reaja** durante o evento: observar o painel, perceber a saturação e
aumentar as réplicas manualmente.

| Pergunta do operador | Consulta | Sinal de alerta |
|---|---|---|
| Os clientes estão sendo bem atendidos? | `100 * sum(rate(http_request_duration_seconds_bucket{job="api", le="0.5"}[1m])) / sum(rate(http_request_duration_seconds_count{job="api"}[1m]))` | abaixo de 99 % |
| As réplicas estão no limite? | `rate(process_cpu_seconds_total{job="api"}[1m])` | perto de 0,5 núcleo (o limite do contêiner) |
| Quanto cada réplica está recebendo? | `sum(rate(http_request_duration_seconds_count{job="api"}[1m])) / count(up{job="api"} == 1)` | acima da capacidade medida por réplica |
| A demanda está subindo? | `rate(nginx_http_requests_total[1m])` | crescimento rápido |

A ação é o mesmo comando do planejamento, executado durante o evento:

```bash
docker compose up -d --scale api=N
```

Tecnicamente, a intervenção é rápida: nos testes, as réplicas novas subiram em
segundos e passaram a receber tráfego e a ser coletadas em até 10 s, sem
reiniciar o Nginx nem o Prometheus (seção 6.2).

O que limita a intervenção manual é o **tempo humano**. Somam-se:

1. **detectar:** alguém precisa estar olhando o painel, ou ser avisado;
2. **decidir:** interpretar os gráficos e escolher quantas réplicas subir;
3. **agir:** executar o comando.

No teste, o SLO caiu de 100 % para 0 % em cerca de 45 segundos depois da
abertura da promoção (Figura 5.4), e o pico inteiro durou 3 minutos. Uma reação
humana de alguns minutos chegaria quando o pico já tivesse passado.

O primeiro passo para encurtar esse tempo é automatizar a **detecção**: o
Prometheus avalia regras de alerta (`alerting rules`) com as mesmas consultas
acima e, por meio do Alertmanager, avisa a equipe quando um limite é cruzado.
O passo seguinte é automatizar também a **decisão e a ação**: o mesmo ciclo
de consulta, comparação com um limite e ajuste de réplicas, executado por um
programa. É o que o KEDA faz (seção 8).

## 7.7 Limites do escalonamento planejado

O pré-escalonamento funciona quando o pico é **previsível**, mas tem custos e
riscos:

- **A previsão pode errar.** Se o pico for maior que o previsto, as réplicas
  provisionadas não bastam. Se for menor, paga-se por réplicas ociosas.
- **O pico pode vir em outra hora.** Uma promoção relâmpago, um produto que
  viraliza, uma menção de um influenciador: picos que nenhuma previsão
  antecipa.
- **Manter réplicas extras custa.** Em nuvem, cada réplica tem custo por hora,
  mesmo ociosa.

Isso motiva o próximo cenário: **escalonamento reativo**, em que o próprio
sistema observa as métricas coletadas pelo Prometheus e ajusta o número de
réplicas conforme a demanda (KEDA, seção 8).

As duas abordagens se complementam: o planejamento define uma **base** para o
pico esperado, e a reação automática cobre o que a previsão não alcançou. Uma
terceira camada, o **controle de admissão** (recusar o excedente com HTTP 429
ou 503), protege quem já está sendo atendido quando nem as duas bastam
(seção 6.5).
