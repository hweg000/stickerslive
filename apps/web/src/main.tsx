import React from "react";
import { createRoot } from "react-dom/client";
import { detectLocale, type ExportArtifact, type LocaleCode } from "@stiksound/core";
import { WebMediaEngine } from "@stiksound/media-web";
import { MyInstantsProvider, TenorGifSource, type FetchLike } from "@stiksound/providers";
import {
  StikSoundMinimalApp,
  type ShareOutcome,
  type ShellBridge,
  type UiLabels
} from "@stiksound/ui";
import "../../../packages/ui/src/styles.css";
import "./mobile.css";

/**
 * StikSound web / PWA shell, aimed at iPhone Safari ("Add to Home Screen").
 *
 * Differences from the Chrome extension shell:
 * - MyInstants goes through the Vite dev proxy at /mi (see vite.config.ts), since
 *   myinstants.com sends no CORS headers. Personal/local use only.
 * - Output goes through the system share sheet (WhatsApp, Save Video, Save to Files)
 *   because iOS has no way to put a video file on the clipboard from a web page.
 * - Transparent WebM only where WebCodecs can encode VP9 with alpha (Chrome/Edge desktop, not Safari).
 */

const isTouch = window.matchMedia?.("(pointer: coarse)").matches ?? false;

// The provider validates real https://www.myinstants.com URLs, then we send them to the local proxy.
const proxiedFetch: FetchLike = (input, init) =>
  fetch(
    String(input)
      .replace(/^https:\/\/(www\.)?myinstants\.com/, "./mi")
      .replace(/^https:\/\/tenor\.com/, "./tenor"),
    init
  );
const myInstants = new MyInstantsProvider(proxiedFetch);
const gifSource = new TenorGifSource(proxiedFetch);
const providers = [myInstants];
const searchMyInstants = (query: string, page: number) => myInstants.search(query, page);

function toFile(artifact: ExportArtifact): File {
  return new File([artifact.bytes.slice().buffer], artifact.fileName, { type: artifact.mimeType });
}

function canShareFile(file: File): boolean {
  try {
    return typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true;
  } catch {
    return false;
  }
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function shareFile(file: File): Promise<ShareOutcome | "unsupported"> {
  if (!canShareFile(file)) return "unsupported";
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (err) {
    const name = (err as DOMException | undefined)?.name;
    if (name === "AbortError") return "cancelled";
    // Safari only allows share() right after a tap. Encoding takes a few seconds,
    // so the first attempt can expire; the UI then asks for one more tap.
    if (name === "NotAllowedError") return "needs-tap";
    throw err;
  }
}

/** On phones, saving goes through the share sheet when it can (Save Video / Save to Files). */
async function saveFile(file: File): Promise<void> {
  if (isTouch) {
    const outcome = await shareFile(file);
    if (outcome === "shared" || outcome === "cancelled") return;
  }
  downloadFile(file);
}

const shell: ShellBridge = {
  async shareArtifact(artifact) {
    const file = toFile(artifact);
    const outcome = await shareFile(file);
    if (outcome === "unsupported") {
      downloadFile(file);
      return "shared";
    }
    return outcome;
  },
  async saveArtifact(artifact) {
    await saveFile(toFile(artifact));
  }
};

const webLabels: Record<LocaleCode, Partial<UiLabels>> = {
  es: {
    exportTooltip: "Crear el video y compartirlo",
    exportDisabledMissingAudio: "Agrega un audio (MP3, M4A, WAV)",
    audioPickBtn: "🎵 Subir audio",
    copyAgainBtn: "Compartir",
    downloadTooltip: "Guardar",
    downloadBtnLabel: "Guardar",
    downloadChooseFormat: "Elige qué guardar:",
    downloadFmtMp4: "Video MP4 (5s / 10s)",
    exportSuccessVideo: "Listo. Si no elegiste dónde guardarlo, búscalo en Archivos → Descargas.",
    aboutRights:
      "Versión web. Todo se procesa en tu teléfono; nada se sube a internet. Para usar un sonido de MyInstants, descárgalo primero desde Safari y luego elígelo con el botón de audio. El video dura como máximo 5 o 10 segundos, según el botón de la barra (por defecto, 10).",
    ...(isTouch
      ? {
        stickerDropTitle: "Toca para elegir tu sticker",
        stickerDropHint: "Foto, GIF o video corto desde Fotos o Archivos",
        hoverCropHint: "Arrastra para mover · pellizca para zoom"
      }
      : { stickerDropHint: "Arrastra o haz clic: PNG, GIF, WebP, JPG o video corto (MP4, MOV)" })
  },
  en: {
    exportTooltip: "Make the video and share it",
    exportDisabledMissingAudio: "Add a sound (MP3, M4A, WAV)",
    audioPickBtn: "🎵 Upload sound",
    copyAgainBtn: "Share",
    downloadTooltip: "Save",
    downloadBtnLabel: "Save",
    downloadChooseFormat: "Choose what to save:",
    downloadFmtMp4: "MP4 video (5s / 10s)",
    exportSuccessVideo: "Done. If you didn't pick a place, look in Files → Downloads.",
    aboutRights:
      "Web version. Everything runs on your phone; nothing is uploaded. To use a MyInstants sound, download it in Safari first, then pick it with the sound button. The video is at most 5 or 10 seconds, chosen with the bar button (10 by default).",
    ...(isTouch
      ? {
        stickerDropTitle: "Tap to choose your sticker",
        stickerDropHint: "Photo, GIF or short video from Photos or Files",
        hoverCropHint: "Drag to move · pinch to zoom"
      }
      : { stickerDropHint: "Drop or click: PNG, GIF, WebP, JPG or a short video (MP4, MOV)" })
  },
  pt: {
    exportTooltip: "Criar o vídeo e compartilhar",
    exportDisabledMissingAudio: "Adicione um áudio (MP3, M4A, WAV)",
    audioPickBtn: "🎵 Escolher áudio (MP3, M4A, WAV)",
    copyAgainBtn: "Compartilhar",
    downloadTooltip: "Salvar",
    downloadBtnLabel: "Salvar",
    downloadChooseFormat: "Escolha o que salvar:",
    downloadFmtMp4: "Vídeo MP4 (5s / 10s)",
    exportSuccessVideo: "Pronto. Se você não escolheu um local, procure em Arquivos → Downloads.",
    aboutRights:
      "Versão web. Tudo é processado no seu aparelho; nada é enviado à internet. Para usar um som do MyInstants, baixe o arquivo primeiro e escolha-o pelo botão de áudio. O vídeo dura no máximo 5 ou 10 segundos (10 por padrão).",
    ...(isTouch
      ? {
        stickerDropTitle: "Toque para escolher seu sticker",
        stickerDropHint: "Foto, GIF ou vídeo curto de Fotos ou Arquivos",
        hoverCropHint: "Arraste para enquadrar"
      }
      : { stickerDropHint: "Arraste ou clique: PNG, GIF, WebP, JPG ou vídeo curto (MP4, MOV)" })
  },
  fr: {
    exportTooltip: "Créer la vidéo et la partager",
    exportDisabledMissingAudio: "Ajoutez un audio (MP3, M4A, WAV)",
    audioPickBtn: "🎵 Choisir un son (MP3, M4A, WAV)",
    copyAgainBtn: "Partager",
    downloadTooltip: "Enregistrer",
    downloadBtnLabel: "Enregistrer",
    downloadChooseFormat: "Choisissez quoi enregistrer :",
    downloadFmtMp4: "Vidéo MP4 (5s / 10s)",
    exportSuccessVideo: "Terminé. Si vous n'avez pas choisi d'emplacement, vérifiez Fichiers → Téléchargements.",
    aboutRights:
      "Version web. Tout est traité sur votre appareil ; rien n'est envoyé en ligne. Pour utiliser un son MyInstants, téléchargez-le d'abord puis sélectionnez-le avec le bouton audio. Durée max : 5 ou 10 s (10 par défaut).",
    ...(isTouch
      ? {
        stickerDropTitle: "Touchez pour choisir votre sticker",
        stickerDropHint: "Photo, GIF ou courte vidéo depuis Photos ou Fichiers",
        hoverCropHint: "Glissez pour cadrer"
      }
      : { stickerDropHint: "Déposez ou cliquez : PNG, GIF, WebP, JPG ou courte vidéo (MP4, MOV)" })
  },
  de: {
    exportTooltip: "Video erstellen und teilen",
    exportDisabledMissingAudio: "Ton hinzufügen (MP3, M4A, WAV)",
    audioPickBtn: "🎵 Ton wählen (MP3, M4A, WAV)",
    copyAgainBtn: "Teilen",
    downloadTooltip: "Speichern",
    downloadBtnLabel: "Speichern",
    downloadChooseFormat: "Speicherformat wählen:",
    downloadFmtMp4: "MP4-Video (5s / 10s)",
    exportSuccessVideo: "Fertig. Falls kein Ort gewählt wurde, schau unter Dateien → Downloads nach.",
    aboutRights:
      "Web-Version. Alles läuft lokal auf deinem Gerät; nichts wird hochgeladen. Für MyInstants-Sounds lade die MP3-Datei zuerst herunter und wähle sie über den Audio-Button. Maximale Videolänge: 5 oder 10 Sekunden (Standard: 10).",
    ...(isTouch
      ? {
        stickerDropTitle: "Tippe, um deinen Sticker zu wählen",
        stickerDropHint: "Foto, GIF oder kurzes Video aus Fotos oder Dateien",
        hoverCropHint: "Zum Zuschneiden ziehen"
      }
      : { stickerDropHint: "Ablegen oder klicken: PNG, GIF, WebP, JPG oder kurzes Video (MP4, MOV)" })
  },
  it: {
    exportTooltip: "Crea il video e condividilo",
    exportDisabledMissingAudio: "Aggiungi un audio (MP3, M4A, WAV)",
    audioPickBtn: "🎵 Scegli audio (MP3, M4A, WAV)",
    copyAgainBtn: "Condividi",
    downloadTooltip: "Salva",
    downloadBtnLabel: "Salva",
    downloadChooseFormat: "Scegli cosa salvare:",
    downloadFmtMp4: "Video MP4 (5s / 10s)",
    exportSuccessVideo: "Fatto. Se non hai scelto una cartella, guarda in File → Download.",
    aboutRights:
      "Versione web. Tutto viene elaborato sul dispositivo; nulla viene caricato online. Per usare un audio di MyInstants, scaricalo prima e selezionalo dal pulsante audio. Durata massima: 5 o 10 secondi (10 predefinito).",
    ...(isTouch
      ? {
        stickerDropTitle: "Tocca per scegliere lo sticker",
        stickerDropHint: "Foto, GIF o breve video da Foto o File",
        hoverCropHint: "Trascina per inquadrare"
      }
      : { stickerDropHint: "Trascina o clicca: PNG, GIF, WebP, JPG o breve video (MP4, MOV)" })
  },
  ru: {
    exportTooltip: "Создать видео и поделиться",
    exportDisabledMissingAudio: "Добавьте аудио (MP3, M4A, WAV)",
    audioPickBtn: "🎵 Выбрать звук (MP3, M4A, WAV)",
    copyAgainBtn: "Поделиться",
    downloadTooltip: "Сохранить",
    downloadBtnLabel: "Сохранить",
    downloadChooseFormat: "Выберите, что сохранить:",
    downloadFmtMp4: "Видео MP4 (5 с / 10 с)",
    exportSuccessVideo: "Готово. Если место не выбрано, проверьте Файлы → Загрузки.",
    aboutRights:
      "Веб-версия. Всё обрабатывается на вашем устройстве; ничего не загружается в сеть. Чтобы использовать звук с MyInstants, сначала скачайте его и выберите кнопкой аудио. Максимум 5 или 10 с (по умолчанию 10).",
    ...(isTouch
      ? {
        stickerDropTitle: "Нажмите, чтобы выбрать стикер",
        stickerDropHint: "Фото, GIF или короткое видео из Фото или Файлов",
        hoverCropHint: "Потяните для кадрирования"
      }
      : { stickerDropHint: "Перетащите или нажмите: PNG, GIF, WebP, JPG или короткое видео (MP4, MOV)" })
  },
  zh: {
    exportTooltip: "生成视频并分享",
    exportDisabledMissingAudio: "请添加音频（MP3、M4A、WAV）",
    audioPickBtn: "🎵 选择音频（MP3、M4A、WAV）",
    copyAgainBtn: "分享",
    downloadTooltip: "保存",
    downloadBtnLabel: "保存",
    downloadChooseFormat: "选择保存内容：",
    downloadFmtMp4: "MP4 视频（5 秒 / 10 秒）",
    exportSuccessVideo: "完成。若未选择保存位置，请在“文件 → 下载”中查看。",
    aboutRights:
      "网页版。所有处理均在本地设备完成，不会上传任何数据。如需使用 MyInstants 音效，请先在浏览器中下载后，再通过音频按钮选择。最长 5 秒或 10 秒（默认 10 秒）。",
    ...(isTouch
      ? {
        stickerDropTitle: "轻点以选择贴纸",
        stickerDropHint: "从“照片”或“文件”选择图片、GIF 或短视频",
        hoverCropHint: "拖动以调整构图"
      }
      : { stickerDropHint: "拖入或点击：PNG、GIF、WebP、JPG 或短视频 (MP4, MOV)" })
  },
  ar: {
    exportTooltip: "إنشاء الفيديو ومشاركته",
    exportDisabledMissingAudio: "أضف ملفًا صوتيًا (MP3, M4A, WAV)",
    audioPickBtn: "🎵 اختر صوتًا (MP3, M4A, WAV)",
    copyAgainBtn: "مشاركة",
    downloadTooltip: "حفظ",
    downloadBtnLabel: "حفظ",
    downloadChooseFormat: "اختر ما تريد حفظه:",
    downloadFmtMp4: "فيديو MP4 (5 أو 10 ثوانٍ)",
    exportSuccessVideo: "تم. إذا لم تختر مكانًا للحفظ، فابحث في الملفات ← التنزيلات.",
    aboutRights:
      "نسخة الويب. تتم المعالجة بالكامل على جهازك ولا يُرفع شيء إلى الإنترنت. لاستخدام صوت من MyInstants، نزّله أولاً ثم اختره عبر زر الصوت. المدة القصوى 5 أو 10 ثوانٍ (10 افتراضيًا).",
    ...(isTouch
      ? {
        stickerDropTitle: "اضغط لاختيار الملصق",
        stickerDropHint: "صورة أو GIF أو فيديو قصير من الصور أو الملفات",
        hoverCropHint: "اسحب لضبط الإطار"
      }
      : { stickerDropHint: "أسقط أو انقر: PNG أو GIF أو WebP أو JPG أو فيديو قصير (MP4, MOV)" })
  }
};

const locale: LocaleCode = detectLocale(navigator.language);

/**
 * Offer "Transparent" only where the export really keeps alpha (see web-media-engine.ts):
 * WebCodecs VP9 with alpha, or Chromium's MediaRecorder, which writes WebM alpha
 * (Chromium's WebCodecs does not). Safari has neither.
 */
async function canEncodeAlphaWebm(): Promise<boolean> {
  // shortcut: userAgentData only exists in Chromium (Chrome/Edge/Opera); a real probe recording would cost ~1 s at startup.
  const isChromium = "userAgentData" in navigator;
  if (isChromium && typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/webm;codecs=vp9")) {
    return true;
  }
  try {
    if (typeof VideoEncoder === "undefined") return false;
    const config = {
      codec: "vp09.00.10.08",
      width: 512,
      height: 512,
      bitrate: 1_200_000,
      framerate: 24,
      alpha: "keep"
    } as VideoEncoderConfig;
    const support = await VideoEncoder.isConfigSupported(config);
    // Browsers drop config members they don't understand, so "alpha" must come back.
    return support.supported === true && (support.config as { alpha?: string } | undefined)?.alpha === "keep";
  } catch {
    return false;
  }
}

const root = createRoot(document.getElementById("root")!);
void canEncodeAlphaWebm().then((transparentVideo) =>
  root.render(
    <React.StrictMode>
      <StikSoundMinimalApp
        engine={new WebMediaEngine()}
        providers={providers}
        shell={shell}
        initialLocale={locale}
        platform={{ transparentVideo, myInstantsUrl: true, videoStickers: true }}
        labelOverrides={webLabels}
        soundSearch={searchMyInstants}
        gifSource={gifSource}
      />
    </React.StrictMode>
  )
);

if ("serviceWorker" in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  });
}
