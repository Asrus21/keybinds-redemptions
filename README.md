# Keybinds Redemptions

App para Windows que **aperta uma tecla no PC do streamer quando alguém resgata uma recompensa de pontos do canal na Twitch.**

Exemplos: “Pular” aperta Espaço no jogo, “Largar a arma” aperta Ctrl+G, “Trocar a cena” aperta F13 (que você liga a um atalho do OBS), “Segurar o W” segura o W por 3 segundos.

![Tela do app](docs/screenshot.png)

<sub>Print tirado no modo de simulação (fora do Windows). No Windows é a mesma tela, e as teclas são apertadas de verdade.</sub>

## Como funciona

1. O app entra na sua conta da Twitch (login por código, igual ao da TV).
2. Ele se conecta à **EventSub** da Twitch por WebSocket. Assim a Twitch avisa na hora de cada resgate, sem precisar de servidor nem de porta aberta no roteador.
3. Quando chega um resgate de uma recompensa com regra, o app aperta a tecla com a `SendInput` do Windows. A tecla vai para **a janela que estiver em foco**, normalmente o jogo.

As teclas são enviadas como **scancode**, a mesma coisa que o teclado físico manda. Por isso funcionam também em jogos que ignoram tecla “virtual” (DirectInput/Raw Input).

## Instalar

Baixe o instalador na aba **Actions** do repositório (último run verde → artefato `keybinds-redemptions-windows`) ou em **Releases**, se houver uma.

- `Keybinds Redemptions-Setup-x.y.z.exe`: instalador normal.
- `Keybinds Redemptions-Portable-x.y.z.exe`: roda sem instalar.

O executável não tem assinatura digital. Por isso, na primeira vez, o Windows SmartScreen avisa: clique em **Mais informações → Executar assim mesmo**.

## Primeira configuração (uma vez só)

### 1. Crie um app na Twitch

O app precisa de um **Client ID** seu. É de graça e leva um minuto:

O console da Twitch é em inglês; os nomes dos campos estão como aparecem lá.

1. Entre em [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps/create) (**Register Your Application**).
2. **Name**: qualquer um (ex.: `keybinds-do-fulano`).
3. **OAuth Redirect URLs**: `http://localhost`. O app não usa esse endereço, mas o campo é obrigatório.
4. **Category**: *Broadcaster Suite*.
5. **Client Type**: **Public**. Isso é importante: com *Confidential* o app não consegue renovar a sessão sozinho.
6. Clique em **Create**, depois em **Manage**, e copie o **Client ID**.

### 2. Entre com a Twitch

1. Abra o app, cole o Client ID e clique em **Salvar**.
2. Clique em **Entrar com a Twitch**. O navegador abre em `twitch.tv/activate` com um código.
3. Confira se o código é o mesmo que aparece no app e clique em **Autorizar**.

O app só pede a permissão `channel:read:redemptions`, que serve para ler os resgates e a lista de recompensas. Ele não consegue mexer em nada no seu canal.

### 3. Crie as regras

1. Clique em **+ Nova regra**.
2. Escolha a recompensa na lista. A lista vem do seu canal; se criou uma recompensa agora, clique em **Atualizar recompensas**.
3. Clique no campo da tecla e **aperte a tecla ou a combinação** (ex.: Ctrl + G). Ou escolha numa lista, que tem F13–F24, teclas de mídia, teclado numérico etc.
4. Ajuste se quiser:
   - **Segurar**: por quanto tempo a tecla fica apertada. 60 ms é um toque; 3000 ms segura por 3 segundos.
   - **Repetir** e **Intervalo**: aperta várias vezes seguidas.
5. Clique em **Testar**, volte para o jogo e espere 3 segundos: o app aperta a tecla.

Pontos de canal só existem em canais **Afiliados ou Parceiros**.

## No dia a dia

- **Pausar**: os resgates continuam aparecendo na atividade, mas nenhuma tecla é apertada. Bom para menus, cutscenes e pausas.
- **Parar tudo**: interrompe o que estiver rodando, esvazia a fila e **solta todas as teclas**. Use quando alguém resgatar “segurar W por 30 s” na hora errada.
- Os resgates entram numa **fila** e rodam um de cada vez, para dois “segura W” não se atropelarem.
- Fechar a janela deixa o app rodando **na bandeja**, perto do relógio. Para sair de vez, clique com o botão direito no ícone e escolha **Sair**. Pausar e Parar tudo também estão nesse menu.
- **Abrir junto com o Windows** já inicia o app na bandeja.

### Dica para o OBS

As teclas **F13 a F24** não existem no teclado comum, então nenhum jogo usa. Coloque uma delas como atalho de cena, fonte ou filtro no OBS (**Configurações → Teclas de atalho**) e faça a regra apertar essa tecla. A recompensa passa a controlar o OBS sem risco de apertar nada no jogo.

## Problemas comuns

| Sintoma | Causa e solução |
| --- | --- |
| A tecla não chega no jogo, mas funciona no Bloco de Notas | O jogo roda **como administrador**. O Windows não deixa um app comum mandar tecla para um app elevado. Abra o Keybinds Redemptions como administrador também. |
| A atividade mostra “falhou: O Windows bloqueou a tecla” | Mesmo caso de cima. |
| Funciona em tudo menos em um jogo específico | Alguns anticheats ignoram de propósito teclas simuladas. Não tem como contornar pelo app. Também vale conferir as regras do jogo sobre automação antes de usar em partida ranqueada. |
| A tecla foi para a janela errada | O app aperta na janela **em foco**. Deixe o jogo em foco. |
| “Só canais Afiliados ou Parceiros têm pontos do canal” | A Twitch só libera recompensas para Afiliados/Parceiros. |
| O app pediu para entrar de novo | Aconteceu uma destas coisas: a autorização foi removida em Configurações → Conexões da Twitch, o Client ID mudou, ou o app ficou mais de 30 dias sem abrir (é o limite da sessão de app público). |

## Privacidade

- Os tokens da Twitch ficam em `%APPDATA%\Keybinds Redemptions\tokens.bin`, **cifrados pelo Windows (DPAPI)**. Só o seu usuário do Windows consegue ler.
- As regras e as preferências ficam em `config.json`, na mesma pasta.
- O app só se comunica com a Twitch (`id.twitch.tv`, `api.twitch.tv` e `eventsub.wss.twitch.tv`). Ele não envia nada para nenhum outro lugar.
- O texto que os viewers mandam junto com o resgate é ignorado. A tecla é escolhida só pela recompensa, então ninguém do chat consegue fazer o app apertar outra coisa.

## Desenvolvimento

Precisa de Node.js 22+.

```sh
npm install
npm start          # abre o app (fora do Windows, as teclas são só simuladas)
npm test           # testes (node:test)
npm run dist       # gera o instalador e o portátil em dist/ (rodar no Windows)
```

O instalador é gerado pelo GitHub Actions (`.github/workflows/build.yml`) em todo push e PR. Para publicar uma Release, crie uma tag `v*`:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Há duas formas de não precisar colar o Client ID na tela:

- **`twitchClientId` no `package.json`**: o instalador já sai configurado. Útil para distribuir o app para outros streamers com o seu app da Twitch.
- **Variável de ambiente `TWITCH_CLIENT_ID`**: tem prioridade sobre tudo. Útil em desenvolvimento.

### Estrutura

```
src/
  main/
    main.js            Electron: janela, bandeja e IPC
    controller.js      login, conexão, regras e fila (sem Electron; testável)
    runner.js          fila que aperta as teclas e sempre as solta no fim
    rules.js           formato e limites de uma regra
    store.js           config.json + tokens cifrados
    keyboard/win32.js  SendInput via koffi (FFI), com scancodes
    twitch/auth.js     Device Code Flow, refresh, validate e revoke
    twitch/api.js      Helix (usuário, recompensas, inscrição na EventSub)
    twitch/eventsub.js WebSocket da EventSub: keepalive, reconnect, deduplicação
  shared/keys.js       tabela de teclas (KeyboardEvent.code → scancode)
  preload.js           ponte segura entre a tela e o processo principal
  renderer/            tela (HTML/CSS/JS, sem framework)
test/                  testes; inclui uma user32 falsa em C para testar a FFI no Linux
```
