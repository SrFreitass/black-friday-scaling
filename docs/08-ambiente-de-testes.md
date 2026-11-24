# 8. Ambiente de testes

> Configuração coletada em 2026-11-24, antes da rodada de testes das seções 5 e 6.

## 8.1 Máquina

| Item | Configuração |
|---|---|
| Processador | AMD Ryzen 5 4500: 6 núcleos físicos, 12 threads, 3,6 GHz nominais |
| Cache | L2 de 3 MiB, L3 de 4 MiB (valores vistos pela VM) |
| Memória | 24 GB DDR4 (8 GB + 16 GB) a 2667 MT/s |
| Disco | SSD |
| Sistema | Windows 11 Pro (build 26300) |
| Plano de energia | Ultra Performance |

## 8.2 Virtualização

| Item | Configuração |
|---|---|
| WSL2 | Debian 13, kernel 6.18.54.1 |
| Recursos da VM | 12 CPUs virtuais (threads), 11,6 GiB de memória, 3 GiB de swap |
| Docker | Docker Desktop, Engine 29.9.2, Compose 5.6.1, cgroup v2 |

Todos os contêineres, incluindo o gerador de carga, rodam na mesma VM. As 12 CPUs
são threads: duas threads do mesmo núcleo compartilham unidades de execução, então
12 CPUs virtuais não equivalem a 12 núcleos.

## 8.3 Contêineres

| Contêiner | Imagem | CPU | Memória | Réplicas |
|---|---|---|---|---|
| API | Bun 1.4.5 + Fastify 5.12.8 | **0,5** | **256 MB** (+ 256 MB de swap) | 1 ou 4 |
| Nginx | `nginx:1.31.9` | sem limite | sem limite | 1 |
| PostgreSQL | `postgres:17` (17.12) | sem limite | sem limite | 1 |
| Prometheus | `prom/prometheus:v3.16.0` | sem limite | sem limite | 1 |
| Exporter do Nginx | `nginx/nginx-prometheus-exporter:1.5.3` | sem limite | sem limite | 1 |
| Node Exporter | `prom/node-exporter:v1.13.1` | sem limite | sem limite | 1 |
| k6 | `grafana/k6:2.4.0` | sem limite | sem limite | 1, só durante o teste |

Nenhum contêiner tem política de reinício.

| Serviço | Parâmetros relevantes |
|---|---|
| API | *pool* de 10 conexões com o banco por réplica (padrão do `pg`) |
| Nginx | 12 processos *worker* (`worker_processes auto`), 1.024 conexões por *worker*, `keepalive_timeout` de 65 s |
| PostgreSQL | `max_connections` 100, `shared_buffers` 160 MB, `work_mem` 4 MB, `fsync` e `synchronous_commit` ligados |
| Prometheus | coleta a cada 15 s, retenção de 15 dias |

## 8.4 Procedimento

| Cenário | Réplicas | Balanceamento | Pico |
|---|---|---|---|
| 1 réplica | 1 | não se aplica | 3× (2.826 req/s) |
| Round-robin, sobrecarga | 4 | round-robin | 3× (2.826 req/s) |
| `least_conn`, sobrecarga | 4 | `least_conn` | 3× (2.826 req/s) |
| Round-robin, com folga | 4 | round-robin | 1,5× (1.413 req/s) |
| `least_conn`, com folga | 4 | `least_conn` | 1,5× (1.413 req/s) |

- **Três execuções por cenário**, 15 no total, em sequência (19:18 a 20:54 UTC).
- **Ordem alterada a cada repetição**, para que um cenário não ocupe sempre a mesma
  posição na sequência.
- **API e Nginx recriados antes de cada execução.** O teste só começa quando o
  Prometheus vê o número exato de réplicas e o balanceamento carregado é conferido.
- **k6 em contêiner**, na rede do Compose, acessando o Nginx pelo nome do serviço.
- Nas seções 5 e 6, os valores são a **mediana das três execuções**, com o mínimo e o
  máximo entre colchetes. "Platô" é a janela de 140 s dentro do pico, de 105 s a 245 s
  após o início. Os percentis do k6 cobrem o teste inteiro.

Os dados de cada execução estão em `docs/dados/rodada-2-2026-11-24.csv`.

## 8.5 Validade das execuções

| Verificação | Resultado |
|---|---|
| CPU da máquina antes de cada execução | 0,1 % a 0,5 % |
| CPU de outros processos do WSL durante o teste | no máximo 0,21 de 12 CPUs |
| Requisições com erro | 0 nas 15 execuções |
| Réplicas encerradas ou reiniciadas | nenhuma |
| Contagem k6, Nginx e API | iguais nas 5 execuções conferidas; o Nginx tem 23 a mais, das coletas do exporter |

Nenhuma execução foi descartada.

## 8.6 Limitações

- **Gerador de carga na mesma máquina.** O k6 usou de 0,6 a 2,0 CPUs no pico e disputa
  recursos com o sistema testado.
- **Processos do Windows não foram medidos**: a amostragem só vê o WSL.
- **Três repetições** mostram a variação, mas são poucas para testes estatísticos.
- **A tabela `orders` cresceu** de 204 mil para 1,13 milhão de linhas ao longo da rodada.
  A rotação da ordem dos cenários reduz o efeito disso na comparação, sem eliminá-lo.
