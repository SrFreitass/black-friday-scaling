# 1. A aplicação: uma loja mínima para a Black Friday

> Rascunho de documentação do processo, para virar seção do artigo.
> Estado registrado em 2026-11-23.

## 1.1 Objetivo

Para observar como um sistema se comporta sob o tráfego de uma Black Friday, é
preciso primeiro **um sistema**. Em vez de usar uma aplicação pronta, foi
construída uma loja virtual mínima, com apenas o necessário para reproduzir as
duas operações que dominam um e-commerce em dia de promoção:

| Operação | Comportamento do cliente | Endpoint | Natureza |
|---|---|---|---|
| Navegar no catálogo | a maioria dos visitantes | `GET /products` | leitura |
| Comprar | uma parte menor dos visitantes | `POST /orders` | leitura + escrita |

A aplicação é propositalmente simples: o foco do trabalho não é a loja, mas a
**observação** dela com o Prometheus. Uma aplicação pequena deixa claro de onde
vem cada número medido.

## 1.2 Tecnologias

| Componente | Tecnologia | Versão |
|---|---|---|
| Runtime | Bun | 1.4.5 |
| Framework HTTP | Fastify | 5.12.8 |
| Banco de dados | PostgreSQL | 17.12 |
| Driver do banco | node-postgres (`pg`) | 8.23.1 |
| Linguagem | TypeScript | — |
| Contêineres | Docker + Docker Compose | — |

O **Bun** executa TypeScript diretamente, sem etapa de compilação, o que
simplifica a imagem Docker: o contêiner roda o código-fonte como está.

## 1.3 Arquitetura do código

O servidor é organizado em camadas, cada uma com uma responsabilidade:

```
requisição HTTP
      │
      ▼
config/server.ts      rotas: liga cada URL ao método de um controller
      │
      ▼
controller/           valida a entrada e escolhe o código de status HTTP
      │
      ▼
model/                regras de negócio e consultas SQL
      │
      ▼
db/database.ts        pool de conexões com o PostgreSQL (instância única)
```

### Pool de conexões

Abrir uma conexão TCP com o PostgreSQL a cada requisição seria caro: envolve o
handshake TCP, a autenticação e a criação de um processo no servidor do banco.
Por isso, `db/database.ts` cria **um único pool** de conexões, compartilhado por
toda a aplicação. As conexões são abertas sob demanda e **reaproveitadas** entre
as requisições.

O tamanho padrão desse pool no `pg` é de **10 conexões**. Ou seja, cada réplica
da API faz no máximo 10 consultas simultâneas ao banco; as demais esperam numa
fila dentro da própria aplicação. Esse número volta a importar quando a API é
replicada (seção de escalabilidade): com *N* réplicas, o banco recebe até
*10 × N* conexões, e o PostgreSQL aceita 100 por padrão (`max_connections`).

## 1.4 Modelo de dados

Duas tabelas, criadas por scripts SQL executados na primeira inicialização do
banco:

```
products                         orders
─────────────────────────        ─────────────────────────────────
id      SERIAL  PK         ◄──── product_id  (FK → products.id)
name    VARCHAR(255)             id          SERIAL  PK
price   NUMERIC(10,2)            quantity    INTEGER
                                 price       NUMERIC(10,2)
                                 created_at  TIMESTAMP (padrão: NOW())
```

- O preço é guardado como `NUMERIC(10,2)`, e não como ponto flutuante, para
  evitar erros de arredondamento com dinheiro.
- O pedido grava o **preço total no momento da compra** (preço do produto ×
  quantidade). Se o preço do produto mudar depois, o pedido antigo não muda.
- O catálogo é populado com **64 produtos** de 9 categorias (eletrônicos, casa,
  roupas, esportes, livros, mercado, beleza, pets e brinquedos), com preços de
  R$ 3,29 a R$ 4.599,00.

Os scripts ficam em `server/src/db/migrations/` e são montados em
`/docker-entrypoint-initdb.d` no contêiner do PostgreSQL, que os executa **em
ordem alfabética** (`01_`, `02_`, `03_`) e **somente quando o volume de dados
está vazio**.

## 1.5 API

| Método | Rota | Resposta |
|---|---|---|
| `GET` | `/products` | lista dos 64 produtos |
| `GET` | `/orders` | lista de todos os pedidos |
| `POST` | `/orders` | cria um pedido a partir de `{ "product_id": number, "quantity": number }` |

Fluxo do `POST /orders`:

1. o controller valida a entrada (`quantity > 0` e `product_id` numérico);
2. o model busca o produto pelo `id`;
3. se o produto não existe, responde **400** com `Product <id> not found`;
4. senão, calcula o preço total e insere o pedido;
5. responde com o pedido criado (`id`, `product_id`, `quantity`, `price`,
   `created_at`).

Um pedido envolve, portanto, **duas consultas** ao banco (um `SELECT` e um
`INSERT`), enquanto listar o catálogo envolve **uma**. Essa diferença aparece
nos testes de carga: a compra suporta menos requisições por segundo que a
leitura.

Os casos de teste manuais ficam em `server/api.http` (sucesso, produto
inexistente, `product_id` inválido, quantidade negativa, corpo vazio e rota
inexistente).

## 1.6 Contêineres e limite de recursos

A API e o banco rodam com Docker Compose. A imagem da API parte de
`oven/bun`, copia o código e instala as dependências com
`bun install --frozen-lockfile` (versões travadas pelo `bun.lock`).

A API roda com recursos **limitados de propósito**:

```yaml
deploy:
  resources:
    limits:
      cpus: "0.5"     # meio núcleo de CPU
      memory: 256M
```

Sem limite, a API usaria toda a máquina de desenvolvimento, e o resultado dos
testes de carga dependeria do computador em que rodaram. Com o limite:

- a capacidade de **uma réplica** vira um valor fixo e reproduzível;
- é possível levar a API à saturação com um gerador de carga rodando na mesma
  máquina;
- o cenário se aproxima do Kubernetes, onde cada pod declara seus limites de
  CPU e memória (`resources.limits`), e escalar significa adicionar réplicas
  desse mesmo tamanho.

## 1.7 Simplificações e limitações conhecidas

A loja não pretende ser um e-commerce completo. As limitações abaixo são
conhecidas e ficam **fora do escopo** deste trabalho, mas são citadas porque
afetam a escalabilidade de um sistema real:

- **Sem controle de estoque.** Não há quantidade disponível por produto, logo
  não existe o problema de vender mais do que se tem (*overselling*), que numa
  Black Friday real exige transações e controle de concorrência no banco.
- **Sem transação no pedido.** O `SELECT` do produto e o `INSERT` do pedido são
  consultas independentes.
- **`GET /orders` sem paginação.** A rota devolve todos os pedidos; o tempo de
  resposta cresce com o tamanho da tabela. Durante os testes, com cerca de 24
  mil pedidos acumulados, essa rota chegou a ~311 ms, contra poucos
  milissegundos com a tabela vazia.
- **Validação manual e incompleta.** Algumas entradas inválidas passam pelo
  controller e só falham no banco, resultando em **500** em vez de **400**:

  | Entrada | Resposta |
  |---|---|
  | requisição sem corpo | 500 |
  | `{"product_id": 1}` (sem `quantity`) | 500 (violação de `NOT NULL`) |
  | `quantity: 1.5` | 500 (não é inteiro) |

  Além disso, as respostas 500 expõem a mensagem de erro interna do banco ao
  cliente. Numa aplicação real, a validação seria feita por um schema na rota
  (o Fastify suporta JSON Schema nativamente) e os erros internos não seriam
  repassados.
- **Banco único.** Todas as réplicas da API compartilham o mesmo PostgreSQL.
  Escalar a API horizontalmente não escala o banco: a partir de certo ponto, o
  gargalo passa a ser ele.

## 1.8 Problemas encontrados durante a construção

Registro dos problemas que apareceram no caminho, com a causa e a correção:

1. **Banco sem produtos.** Um erro de sintaxe (uma vírgula) em `02_orders.sql`
   interrompeu a inicialização do PostgreSQL, e o script de carga dos produtos
   nunca rodou. Como os scripts só executam com o volume vazio, corrigir o
   arquivo não bastou: foi preciso recriar o volume
   (`docker compose down -v`).
2. **`this` indefinido nos controllers.** Passar o método diretamente para a
   rota (`app.get('/products', productsController.list)`) faz o método perder a
   referência ao objeto: ele é chamado "solto", e `this.productModel` não
   existe. A correção foi envolver a chamada numa função de seta
   (`() => productsController.list()`), que preserva o objeto.
3. **API derrubada por falta de memória.** No primeiro teste de carga, o k6 foi
   configurado com até 20 mil usuários virtuais. Cada um mantém uma conexão
   aberta com a API, e o processo ultrapassou os 256 MB: o Docker o encerrou
   (*OOMKilled*, código de saída 137). Como o Compose não tinha política de
   reinício, a API ficou fora do ar. Lição para a seção de testes: **sobrecarga
   não apenas deixa o sistema lento, pode derrubá-lo**.
