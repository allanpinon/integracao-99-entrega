# Integração Cardápio Web ↔ 99 Entrega

Serviço Node.js que chama um motoboy da 99 Entrega quando a loja atribui o entregador **"99 Entrega"** a um pedido no Cardápio Web, e devolve status e taxa para o próprio CW.

## Como funciona na operação

| Ação da loja no CW | O que o serviço faz | O que aparece no CW |
|---|---|---|
| Atribuir entregador próprio → **99 Entrega** | Cota e cria a corrida na 99 | **Taxa do entregador** = valor cotado pela 99 |
| — | Motoboy coleta (99: `delivering`) | Pedido vai para **Saiu para entrega** |
| — | 99 confirma entrega | Pedido **Entregue**; taxa final atualizada se mudou |
| — | Ninguém aceitou / 99 encerrou | Pedido volta para **Sem entregador** |
| — | Pedido recusado pelas regras | Pedido volta para **Sem entregador** (motivo no log) |
| Trocar o entregador ou cancelar o pedido antes da coleta | Cancela a corrida na 99 | — |

O link de rastreio ao cliente é enviado pela própria 99.

**Regras de recusa** (o pedido volta para "Sem entregador"):
- não é delivery, ou a entrega é da plataforma (iFood, 99Food, Keeta…);
- cliente sem celular brasileiro válido;
- endereço incompleto ou CEP não encontrado (busca no ViaCEP quando o CW não envia);
- pagamento na entrega ainda não marcado como **pago** no CW (desligável com `ALLOW_UNPAID_OFFLINE=true`).

## Pré-requisitos

1. **App privado no Cardápio Web** (integracao@cardapioweb.com), categoria Logística, escopos `orders` e `drivers`:
   - Redirect URI: `{BASE_URL}/oauth/callback`
   - URL de instalação: `{BASE_URL}/cw/install`
   - URL de login: `{BASE_URL}/cw/login`
   - Webhook: não é necessário (o serviço usa polling, porque atribuir entregador não dispara webhook no CW)
2. **Conta de desenvolvedor na 99 Entrega** (Client ID/Secret de teste) e, no painel da 99, a URL de webhook `{BASE_URL}/webhooks/99`.
3. Em **CW01 e CW02**: cadastrar um entregador ativo chamado exatamente **99 Entrega**.

## Implantação no Railway

1. Novo serviço a partir desta pasta (Node ≥ 22.13; sem dependências nativas).
2. Adicionar um **Volume** montado em `/data` (guarda tokens e histórico das corridas).
3. Variáveis: copiar de `.env.example`.
4. Depois do deploy, como Proprietário de cada loja, abrir `{BASE_URL}/cw/install` e autorizar. A página final confirma a loja e se o entregador "99 Entrega" foi encontrado.

Painel técnico: `{BASE_URL}/status?token={ADMIN_TOKEN}` (lojas instaladas + últimas corridas).

## Testes

`npm test` roda o fluxo completo contra simulações do CW e da 99 (9 cenários: fluxo feliz, recusa por pagamento, troca de entregador, cancelamento no CW, timeout + nova tentativa, reconciliação sem webhook, pedido de marketplace, assinatura inválida).

## Checklist no sandbox (antes da produção)

- [ ] Atribuir "99 Entrega" no portal e confirmar que a corrida é criada em até 30 s.
- [ ] Conferir se a **Taxa do entregador** no pedido mostra o valor da 99.
- [ ] Campo `cep` vs `CEP` na 99: a doc usa os dois; o serviço envia `cep`. Se a 99 recusar com errno 1001, trocar em `src/rules.js`.
- [ ] Assinatura do webhook: o serviço aceita Base64 e hex; confirmar qual a 99 envia.
- [ ] Transição `confirmed → ready → released` no CW quando o motoboy coleta.
- [ ] Link de rastreio chegando ao cliente em corrida criada pela API.
- [ ] Testes obrigatórios da 99 para liberar produção: cotar, criar, cancelar, consultar, webhook.

## Estrutura

```
src/server.js   rotas (instalação OAuth, webhook 99, status)
src/poller.js   leitura do CW a cada 30 s + reconciliação com a 99 a cada 60 s
src/jobs.js     ciclo de vida da corrida (criar, sincronizar, cancelar, desistir)
src/rules.js    validação do pedido, telefone, CEP, montagem dos endereços
src/cw.js       cliente da API do Cardápio Web (OAuth PKCE, pedidos, entregador)
src/n99.js      cliente da API da 99 Entrega (token, cotação, criação, webhook)
src/db.js       SQLite embutido (node:sqlite)
```
