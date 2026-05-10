# Strix · finanças sob comando

PWA standalone — funciona offline, instala como app no celular, dados 100% locais (IndexedDB).

## O que é PWA?

É uma página web que se comporta como app nativo: instala na tela inicial, abre em tela cheia (sem barra do navegador), funciona offline, recebe notificações. Não precisa de loja de apps.

---

## Como rodar e instalar (3 caminhos)

### Caminho 1 — Celular Android, do jeito mais simples (recomendado)

Você precisa hospedar os arquivos em algum lugar acessível por HTTPS. A opção mais fácil e gratuita é o **GitHub Pages**:

1. Crie uma conta gratuita em [github.com](https://github.com).
2. Crie um repositório novo, marcado como **Public**, com nome `strix` (ou o que quiser).
3. Faça upload de todos os arquivos da pasta `strix/` (arrastar e soltar funciona):
   - `index.html`
   - `strix.js`
   - `sw.js`
   - `manifest.webmanifest`
   - `icon.svg`
   - `icon-192.png`
   - `icon-512.png`
   - `icon-maskable-512.png`
4. Em **Settings → Pages**, escolha:
   - Source: **Deploy from a branch**
   - Branch: **main**, pasta `/ (root)`, e clique **Save**.
5. Aguarde 1–2 minutos. O GitHub vai te dar uma URL tipo `https://seu-usuario.github.io/strix/`.
6. **Abra essa URL no Chrome do seu Android.**
7. Aparece um banner "Adicionar à tela inicial" (ou um botão "Instalar" no canto superior direito do header do app). Toque.
8. Pronto: a coruja Strix aparece na sua tela inicial igual a qualquer app.

### Caminho 2 — iPhone (iOS/Safari)

iOS não dá banner automático. Faça assim:

1. Hospede os arquivos no GitHub Pages como acima.
2. Abra a URL no **Safari** (precisa ser Safari, não Chrome).
3. Toque no botão de **compartilhar** (quadrado com seta para cima).
4. Role para baixo e toque em **"Adicionar à Tela de Início"**.
5. Confirme. O ícone aparece na tela inicial.

> ⚠️ **Limitações no iOS**: Notificações em PWA só funcionam no iOS 16.4+ e exigem permissão explícita. O reconhecimento de voz também depende da versão do Safari. Se notificações não funcionarem, exporte os dados regularmente em backup.

### Caminho 3 — Testar localmente antes (no PC, sem hospedar)

Service workers exigem HTTPS ou localhost. Não dá pra abrir só com clique duplo no `index.html`. Use um servidor local:

```bash
# Se tem Python instalado:
cd strix
python3 -m http.server 8080

# Se tem Node:
npx serve

# Ou Caddy, nginx, etc.
```

Depois abra `http://localhost:8080` no navegador. Todas as features funcionam em localhost.

Para testar do celular na mesma rede Wi-Fi: descubra o IP do PC (`ipconfig` no Windows ou `ifconfig` no Linux/Mac) e abra `http://SEU-IP:8080` no celular. Limitação: notificações e instalação completa exigem HTTPS, mas você consegue testar todas as funcionalidades de captura, voz, dashboard.

---

## Como usar

### Captura por voz ou texto

Toque no microfone ou digite. Frases que entende:

- **Gastos**: "gastei 30 em gasolina", "almoço 25", "uber 18"
- **Orçamento**: "esse mês posso gastar 2500", "essa semana posso gastar 600"
- **Devedores**: "vendi 15 reais para joão", "joão me deve 50"
- **Pagamentos**: "joão me pagou 15", "recebi 100 do pedro"
- **Eu devo**: "devo 200 para maria"
- **Contas**: "conta da tim é 60, vence dia 12, ainda não paguei"
- **Pagar conta**: "paguei a conta da oi"
- **Cartão**: "meus gastos no cartão foram 590"
- **Correção**: "não são 60 no dia 12, e sim 70"
- **Datas**: adicione "ontem", "anteontem", "amanhã", "dia 15", "12/05"

### Coruja flutuante

Aparece no canto inferior direito em qualquer aba. Toque para abrir o painel de captura rápida com voz.

### Quatro abas

- **Capturar** — saldo do mês, gastos do dia/semana, captura rápida, lançamentos recentes
- **Dashboard** — KPIs, gráficos (área/barras/pizza) com período de 7/30/90 dias, top categorias
- **Detalhes** — devedores, contas pendentes (atrasadas em vermelho), histórico com busca
- **Ajustes** — tema, notificações, **backup (exportar/importar JSON)**, apagar tudo

### Backup (importante)

Os dados ficam só no seu celular (IndexedDB). Se você desinstalar o app ou trocar de celular, perde tudo. Por isso:

- Vá em **Ajustes → Backup → Exportar** periodicamente.
- O arquivo `strix-backup-AAAA-MM-DD.json` é baixado.
- Para restaurar: **Ajustes → Backup → Importar** e selecione o arquivo.

---

## Recursos técnicos

**Storage**: IndexedDB com 4 object stores (`transactions`, `debts`, `bills`, `meta`) + audit trail. Índices por data, mês, pessoa, status. Suporta milhares de transações sem perder performance.

**Persistência forçada**: o app pede `navigator.storage.persist()` para impedir que o navegador limpe os dados em situações de pouco espaço.

**Performance**: componentes memoizados (`React.memo`), índices em `Map` para agregações O(n) sem re-cálculo, persistência debounceada.

**Offline-first**: service worker cacheia o app shell + bibliotecas. Funciona sem internet depois da primeira abertura.

**Notificações**: agendadas via service worker quando uma conta vai vencer (1 dia antes às 9h) ou quando o gasto da semana passa de 80% do orçamento.

**Undo**: toda criação de transação/dívida/conta pode ser desfeita por 5 segundos via toast.

**Privacidade**: zero telemetria, zero servidor, zero conta. Os dados nunca saem do seu celular.

---

## Atualizar o app depois de instalado

Se você editar o código no GitHub e fizer push, o service worker detecta a nova versão na próxima abertura. Para forçar atualização imediata: feche o app, reabra, e ele puxará a versão nova.

Se quiser quebrar o cache manualmente, edite `sw.js` e mude `CACHE_VERSION = 'strix-v1'` para `'strix-v2'`.

---

## Limitações conhecidas

- **iOS Safari** tem suporte parcial a Web Speech API (reconhecimento de voz pode falhar).
- **Notificações em iOS** exigem 16.4+ e o app instalado na tela inicial.
- **Background sync** não funciona em iOS — notificações de vencimento só disparam se o app foi aberto recentemente.
- Para um app realmente nativo (com push em background, sincronização em nuvem multi-dispositivo, etc.) seria preciso reescrever em React Native ou similar — me avise se quiser ir nessa direção.
