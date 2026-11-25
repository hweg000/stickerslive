<div align="center">

<img src="docs/assets/app-icon.svg" alt="StikSound App Icon" width="120" height="120" />

# StickSound

> **Fork de [SilverFeit/StikSound](https://github.com/SilverFeit/StikSound), modificado por [hweg000](https://github.com/hweg000).** Principais mudanças: busca de sons (MyInstants) e de GIFs (Tenor) dentro do app, WebM transparente real no Chrome/Edge, enquadramento com arrastar, pinça e zoom, e um design novo. O código original é © 2026 StikSound Contributors (SilverFeit) e é licenciado sob MIT ou Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`); as modificações são publicadas sob as mesmas licenças. Os botões de download e a versão web abaixo são do projeto original.

**Crie vídeos curtos com som de até 5 ou 10 segundos (com seletor na tela) a partir de PNG, JPG, WebP ou GIF animado: cole seu sticker, escolha um áudio local ou um link do MyInstants, recorte o trecho exato e exporte tudo 100% localmente.**

[![Usar na Web](https://img.shields.io/badge/Usar%20na%20Web-GitHub%20Pages-0ea5e9?style=for-the-badge&logo=githubpages&logoColor=white)](https://silverfeit.github.io/StikSound/)
[![Baixar](https://img.shields.io/github/v/release/SilverFeit/StikSound?style=for-the-badge&label=Baixar&color=25D366)](https://github.com/SilverFeit/StikSound/releases/latest)

[![Platforms](https://img.shields.io/badge/Platforms-Web%20%7C%20Windows%20%7C%20macOS%20%7C%20Chrome-25D366?style=flat-square)](#versão-web-vs-instalar)
[![Local Processing](https://img.shields.io/badge/Processamento-100%25%20local-10b981?style=flat-square)](#privacidade-e-segurança)
[![License](https://img.shields.io/badge/License-MIT%20OR%20Apache--2.0-6366f1?style=flat-square)](LICENSE-MIT)

[**Usar na Web**](https://silverfeit.github.io/StikSound/) · [**Baixar**](https://github.com/SilverFeit/StikSound/releases/latest) · [**Guia Passo a Passo**](#guia-passo-a-passo) · [**Como Funciona**](#como-funciona-internamente) · [**Desenvolvimento**](#desenvolvimento)

**🌐 Idioma / Language / Idioma:** [**🇪🇸 Español (Principal)**](README.md) · [**🇺🇸 English**](README.en.md) · **🇧🇷 Português**

</div>

---

## 🌐 Versão Web vs. Instalar

Você pode usar o **StikSound diretamente no navegador** sem instalar nada (funciona no PC, Android e iPhone como PWA), observando a diferença em relação ao **MyInstants**:

> [!IMPORTANT]
> **Versão Web ([silverfeit.github.io/StikSound](https://silverfeit.github.io/StikSound/)):** funciona **apenas com áudios já baixados** no seu aparelho (`MP3`, `WAV`, `M4A`, `OGG`, `AAC`) ou o áudio de um vídeo curto.
>
> **Quer colar links diretos do MyInstants?** Por regras de segurança dos navegadores (CORS), o MyInstants bloqueia downloads diretos a partir de páginas web estáticas. Para usar links do MyInstants diretamente, **instale** o [App de Desktop (Windows/macOS) ou a Extensão do Chrome](https://github.com/SilverFeit/StikSound/releases/latest) — ou baixe o MP3 do MyInstants antes e selecione-o na versão web.

| Recurso | 🌐 Versão Web (GitHub Pages) | 💻 App Desktop / 🧩 Extensão Chrome |
| --- | :---: | :---: |
| **Instalação necessária** | ❌ Nenhuma ([abrir agora](https://silverfeit.github.io/StikSound/)) | ✅ [Baixar release](https://github.com/SilverFeit/StikSound/releases/latest) |
| **Processamento 100% local** | ✅ | ✅ |
| **Stickers PNG / JPG / WebP / GIF** | ✅ | ✅ |
| **Vídeos curtos (`MP4`, `MOV`, `WebM`) como sticker** | ✅ | — |
| **Seletor de duração `5s \| 10s`** | ✅ | ✅ |
| **Áudios locais baixados** | ✅ | ✅ |
| **Colar links diretos do MyInstants** | ❌ *(baixe o MP3 antes)* | ✅ |
| **WebM com transparência** | ❌ *(apenas MP4 na web/celular)* | ✅ |

---

## O que o StikSound faz

O StikSound combina **uma imagem quadrada** e **um trecho de áudio** em um arquivo para baixar ou copiar. A duração máxima é escolhida pelo botão `5s | 10s` (10 segundos por padrão). Tudo é processado localmente no seu dispositivo, sem enviar arquivos para servidores externos.

- Aceita **PNG, JPG/JPEG, WebP e GIF** (além de vídeos curtos `MP4`, `MOV`, `WebM` na versão Web).
- Decodifica **GIFs animados** quadro a quadro e os repete em loop durante o vídeo exportado.
- Aceita áudios locais **MP3, WAV, OGG, M4A ou AAC**, ou links validados do **MyInstants** (Desktop e Extensão Chrome).
- Suporta **9 idiomas integrados na interface** (`ES`, `EN`, `PT`, `FR`, `DE`, `IT`, `RU`, `ZH`, `AR`) no menu `⋯`.
- Exporta **MP4** compatível, **WebM com transparência**, pacotes/projetos **`.stiksound.zip`** ou **WebP estático** (`<= 100 KB`).

> **Nota importante sobre o WhatsApp:** O MP4 exportado é um vídeo comum, não uma figurinha nativa. Colar ou compartilhar no chat envia como vídeo. Apenas em algumas contas beta do Android (não documentadas oficialmente) é possível testar *Criar figurinha* escolhendo o vídeo na galeria, onde o WhatsApp decide a duração e o áudio. O perfil experimental `native-sound-sticker` segue desabilitado.

---

## Guia passo a passo

1. **Carregue o sticker:** Cole com `Ctrl + V` / `Cmd + V`, arraste ou clique na área central (`PNG`, `JPG`, `WebP`, `GIF`; na Web também aceita vídeos curtos).
2. **Enquadre em 1:1:** Imagens não quadradas são centralizadas automaticamente; mova o mouse (ou arraste com o dedo no celular) para ajustar o recorte `1:1` até `512 × 512 px` sem aumentar artificialmente.
3. **Adicione o áudio:** Arraste um arquivo de áudio, clique em **Áudio** ou cole uma URL válida do MyInstants (Desktop/Extensão). Limites: até `25 MB` e `3 minutos`; seleção entre `0,1 s` e `5 s` ou `10 s` (em GIFs animados, a duração mínima é de 1 ciclo do GIF até o limite ativo).
4. **Ajuste o trecho e o fundo:** Clique na forma de onda ou mova o controle deslizante, ouça a prévia e escolha **Transparente** (WebM) ou **Branco / Preto / Cor** (MP4) quando houver transparência.
5. **Pré-visualize, copie ou baixe:** Use `➔` para gerar e copiar/compartilhar, `⬇` para escolher o formato exato, `⋯` para abrir/salvar projetos, trocar o idioma e ver Sobre/licenças, e `✕` para reiniciar.

---

## Como funciona internamente

- **Pipeline de imagem e GIF:** Verifica os bytes reais do arquivo, aplica limites contra decompression bombs e consumo excessivo em GIFs (`300` quadros, `64 MiB` canvas, `256 MiB` RGBA acumulado), calcula o recorte 1:1 e agenda o loop dos quadros compatível com a prévia do navegador.
- **Pipeline de áudio:** Decodifica, mistura para mono, calcula 1024 picos para a forma de onda, recorta `start_ms`–`end_ms` inteiros e reamostra para **48 kHz mono**.
- **Codificação de vídeo:** Usa **WebCodecs (`VideoEncoder` + `AudioEncoder`) + `mp4-muxer` / `webm-muxer` em TypeScript** quando disponível, ou **Canvas + `MediaRecorder`** como alternativa universal.

---

## Estrutura do repositório

```text
apps/
  desktop/       App Tauri para Windows/macOS
  extension/     Extensão Chrome Manifest V3
  web/           App Web / PWA publicado no GitHub Pages
packages/
  core/          Modelo de projeto, invariantes, validação e casos de uso
  ui/            Editor React compartilhado, barra de recorte e i18n (9 idiomas)
  media-web/     Sniffing, decodificação, trim, waveform, mux e ZIP em TypeScript
  providers/     Extração e política de URLs do MyInstants
crates/
  audio-engine/  Probe/decodificação/trim de áudio em Rust
  image-engine/  Probe e utilidades de imagem/GIF em Rust
  video-engine/  Validação e utilidades de mux em Rust
  project-store/ Escrita atômica e pacotes em Rust
docs/            Requisitos, arquitetura, especificações e decisões
```

---

## Instalação

### Windows e macOS
1. Acesse [**Releases**](https://github.com/SilverFeit/StikSound/releases/latest).
2. Baixe o instalador ou executável da sua plataforma (`windows-x64` ou `macos-universal`).
3. Abra o StikSound — não requer FFmpeg nem ferramentas externas. *(No macOS, clique com o botão direito → **Abrir** se aparecer o aviso de desenvolvedor não verificado).*

### Extensão Chrome / Edge / Brave
1. Baixe `StikSound-*-chrome-extension.zip` em [**Releases**](https://github.com/SilverFeit/StikSound/releases/latest) e extraia o arquivo.
2. Abra `chrome://extensions/`, ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e selecione a pasta extraída.

---

## Privacidade e segurança

- Nenhum servidor recebe suas imagens, vídeos ou áudios.
- Todo o processamento de mídia ocorre localmente no dispositivo.
- A única requisição de rede é a resolução de links do MyInstants (apenas Desktop e Extensão Chrome), protegida por lista estrita HTTPS, limite de redirecionamentos, bloqueio de IPs privados/reservados em Rust e limite de 25 MB / 20 s.

---

## Desenvolvimento

```bash
git clone https://github.com/SilverFeit/StikSound.git
cd StikSound
npm install
npm run typecheck
npm test
npm run build
cargo test --workspace --exclude stiksound-desktop
```

## Licença

Licença dupla sob **MIT License** ([LICENSE-MIT](LICENSE-MIT)) ou **Apache License, Version 2.0** ([LICENSE-APACHE](LICENSE-APACHE)), à sua escolha (`MIT OR Apache-2.0`).
