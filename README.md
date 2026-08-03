# Bot de IA de Atendimento — PAD Saúde Caruaru (standalone)

Bot WhatsApp **independente** (não depende do `central-disparo`), com sua
própria conexão Baileys. Responde dúvidas dos clientes automaticamente e
nunca agenda/remarca/cancela consulta sozinho — quando o cliente pede isso,
avisa que vai encaminhar para um atendente humano.

## Arquivos

- `bot.js` — conecta no WhatsApp (Baileys), gera o QR code, escuta mensagens
  recebidas e chama a IA para responder
- `iaAtendimento.js` — lógica da IA (chama a API da Anthropic)
- `clinicaInfo.js` — dados da clínica (⚠️ **edite antes de rodar de verdade**)
- `.gitignore` — evita subir a sessão do WhatsApp e a chave de API pro GitHub

> **Nota sobre o banco de dados:** este projeto usa o módulo `node:sqlite`,
> que já vem embutido no Node.js (a partir da v22.13) — não precisa mais do
> pacote `better-sqlite3` nem de compilar nada (sem Visual Studio Build
> Tools no Windows). Só é preciso ter **Node.js 22.13 ou mais novo**
> instalado (`node -v` pra conferir).

## Painel gerencial (leads e conversas)

O bot agora registra automaticamente **todo mundo que manda mensagem** e o
**histórico completo da conversa** num banco local (`atendimento.db`,
SQLite — criado sozinho na primeira mensagem recebida).

Para ver o painel, com o bot rodando (`node bot.js`), abra no navegador:

```
http://localhost:3000
```

O painel mostra:
- **Cards no topo**: total de leads, leads de hoje, mensagens de hoje, e quantos estão aguardando atendimento humano
- **Lista de conversas** à esquerda (busca por número)
- **Histórico completo** da conversa selecionada à direita, estilo chat
- Atualiza sozinho a cada 8 segundos (não precisa recarregar a página)

Arquivos novos: `db.js` (banco de dados), `server.js` (API do painel),
`public/index.html` (a interface).

## Rodando local (primeira vez)

```bash
npm install
```

**Configure a chave de API usando um arquivo `.env`** (mais confiável do que
colar no terminal toda vez — evita erro de quebra de linha ao colar):

1. Copie o arquivo `.env.example` e renomeie a cópia para `.env` (na mesma pasta do `bot.js`)
2. Abra o `.env` num editor de texto (Bloco de Notas, VS Code) e cole sua chave, assim:
   ```
   ANTHROPIC_API_KEY=sk-ant-api03-sua-chave-aqui
   ```
   Sem aspas, sem espaço antes/depois do `=`, e a chave inteira numa linha só.
3. Salve o arquivo. Pronto — o bot lê essa chave automaticamente toda vez que rodar, sem precisar configurar nada no terminal.

⚠️ O `.env` já está no `.gitignore` — nunca vai parar no GitHub por engano.

Preencha também o `clinicaInfo.js` com os dados reais (endereço, horários,
convênios, especialidades, telefone).

Rode o bot:

```bash
node bot.js
```

Um **QR code vai aparecer no terminal**. Escaneie com o WhatsApp que vai
atender (WhatsApp do celular → Aparelhos conectados → Conectar um aparelho).
Depois de conectar, a sessão fica salva na pasta `auth_info_baileys/` — não
precisa escanear de novo nas próximas vezes, a menos que desconecte o
aparelho ou apague essa pasta.

Mande uma mensagem de outro número para o WhatsApp conectado e veja a IA
responder no terminal e no WhatsApp. Abra `http://localhost:3000` para ver
essa conversa aparecer no painel.

## Colocando em produção (Render)

1. **Confirme que o `.gitignore` está no repositório** (esse arquivo, na raiz
   do projeto) e que `auth_info_baileys/`, `.env` e `atendimento.db` **não**
   aparecem no GitHub — veja `git status` ou olhe direto no site do GitHub.
   Se algum desses já foi commitado antes do `.gitignore` existir, ele
   continua no histórico mesmo depois de adicionar o `.gitignore` agora — é
   preciso removê-lo do Git explicitamente (veja o aviso mais abaixo).

2. No **Render**, crie um novo **Web Service** (não "Background Worker" —
   o bot também serve o painel web numa porta HTTP, então precisa ser Web
   Service):
   - Conecte o repositório do GitHub
   - Build command: `npm install`
   - Start command: `node bot.js`
   - O Render define a porta automaticamente pela variável `PORT` (o
     `server.js` já usa `process.env.PORT` para isso)

3. **Adicione um Persistent Disk** ao serviço (aba "Disks" nas configurações
   do serviço, disponível nos planos pagos) — sem isso, a sessão do WhatsApp
   e o histórico de leads somem a cada novo deploy:
   - Mount path: `/data`
   - Tamanho: 1 GB já é bem confortável pra esse uso

4. Nas **variáveis de ambiente** do serviço no Render (aba "Environment" —
   não é o `.env` local, é uma seção separada no painel do Render), adicione:
   - `ANTHROPIC_API_KEY` = sua chave de API
   - `DADOS_DIR` = `/data` (mesmo caminho do disco persistente do passo 3 —
     é isso que faz a sessão do WhatsApp e o banco de dados sobreviverem
     aos deploys)

5. **Sobre o QR code em produção**: depois do primeiro deploy, abra a aba
   **Logs** do serviço no Render — o QR code aparece ali como texto (modo
   `{ small: true }`, já configurado no código) e normalmente dá pra
   escanear direto da tela de logs, mesmo sendo ASCII. Escaneie com o
   WhatsApp → Aparelhos conectados → Conectar um aparelho. Como o
   `DADOS_DIR` aponta pro disco persistente, isso só precisa ser feito uma
   vez — nos próximos deploys o bot sobe já conectado.

6. **Evite hibernação** (se estiver no plano free do Render, que dorme após
   inatividade): isso derrubaria a conexão do WhatsApp toda hora. Pra um bot
   que precisa ficar sempre online, vale a pena um plano pago que não
   hiberna.

### ⚠️ Se `.env` ou `auth_info_baileys/` já foram parar no GitHub

Se o repositório já existia sem o `.gitignore` e algum desses arquivos foi
commitado, adicionar o `.gitignore` agora **não** os remove do histórico do
Git — quem tiver acesso ao repositório (ou ao histórico, mesmo que os
arquivos tenham sido apagados depois) ainda consegue ver a chave de API e a
sessão do WhatsApp antigas. Nesse caso:
1. **Troque a chave da Anthropic** (gere uma nova em
   https://console.anthropic.com e revogue a antiga) — trate a chave exposta
   como comprometida, mesmo que o repositório seja privado.
2. **Gere uma sessão nova do WhatsApp**: apague a pasta `auth_info_baileys`
   (local e no disco persistente do Render) e escaneie o QR code de novo —
   isso invalida a sessão antiga que ficou exposta.
3. Remova os arquivos do Git (não só do disco): `git rm --cached -r
   auth_info_baileys .env atendimento.db`, depois commit e push. Se o
   repositório for público (ou já foi visto por alguém), isso ainda não some
   do histórico antigo — pra isso, é preciso reescrever o histórico (ex:
   `git filter-repo`) ou, mais simples, apagar o repositório e criar um novo.

## Diferença deste bot para o central-disparo

Este projeto é **separado** do `central-disparo`:
- Roda em processo próprio, com seu próprio `auth_info_baileys/` (sessão de
  WhatsApp independente)
- Pode usar o mesmo número de WhatsApp do central-disparo OU um número
  diferente, dependendo do que você decidir — mas cada processo precisa da
  sua própria sessão conectada
- Não compartilha código com o central-disparo (só reaproveita a mesma ideia
  de listener do Baileys)

## Próximos passos (quando quiser evoluir)

- Persistir o histórico de conversa **da IA** em banco também (hoje a IA usa
  memória RAM para o contexto da conversa — o `atendimento.db` já guarda tudo
  para exibição no painel, mas se o bot reiniciar, a IA "esquece" o contexto
  em andamento, mesmo o painel continuando com o histórico completo)
- Conectar com a AmigoAPI para a IA consultar horários disponíveis (sem
  agendar sozinha)
- Adicionar autenticação simples no painel (`/painel` hoje é público na rede
  onde o bot roda — sem senha)
