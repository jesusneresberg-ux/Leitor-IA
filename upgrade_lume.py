#!/usr/bin/env python3
"""Atualiza o repo Leitor-IA/LUME localmente para leitura limpa offline.
Uso: python upgrade_lume.py /caminho/do/Leitor-IA
Requer internet apenas para baixar o PDF.js na instalação (uma vez).
"""
from __future__ import annotations
import argparse
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path

PDF_VERSION = '4.10.38'
ASSET_DIR = Path('assets/pdfjs')
PDF_FILES = {
    'pdf.min.mjs': f'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/{PDF_VERSION}/pdf.min.mjs',
    'pdf.worker.min.mjs': f'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/{PDF_VERSION}/pdf.worker.min.mjs',
}

WORKER = r'''// LUME — leitura PDF inteiramente local depois da primeira instalação online.
const CACHE = 'lume-reader-offline-v5';
const CORE = ['./', './index.html', './manifest.webmanifest',
              './assets/pdfjs/pdf.min.mjs', './assets/pdfjs/pdf.worker.min.mjs'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k =>
      (k.startsWith('lume-reader-') || k.startsWith('leitor-ia-')) && k !== CACHE
    ).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (req.mode === 'navigate') {
      try {
        const live = await fetch(req);
        if (live.ok) (await caches.open(CACHE)).put(req, live.clone());
        return live;
      } catch (_) {
        return cached || await caches.match('./index.html') || Response.error();
      }
    }
    if (cached) return cached;
    try {
      const live = await fetch(req);
      if (live.ok) (await caches.open(CACHE)).put(req, live.clone());
      return live;
    } catch (_) { return Response.error(); }
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type === 'CACHE_OFFLINE_ENGINE') {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)));
  }
});
'''

STYLE = r'''    /* LUME: foco sem menus fixos, expansão temporária pelo botão flutuante */
    .library-home{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 4px 12px}
    .library-home h2{font-size:22px;letter-spacing:-.02em;margin:3px 0 4px}
    .library-home p{font-size:11px;line-height:1.45;color:var(--muted);margin:0;max-width:420px}
    .library-home .primary-btn{white-space:nowrap;flex-shrink:0;font-size:12px}
    .reader-controls-toggle{display:none;position:absolute;bottom:calc(14px + env(safe-area-inset-bottom));right:14px;width:45px;height:45px;z-index:55;border:1px solid var(--line);border-radius:50%;background:var(--surface);color:var(--accent);box-shadow:0 6px 22px rgba(15,23,42,.2);font-size:22px;place-items:center}
    body.reading-immersive .reader-controls-toggle{display:grid}
    body.reading-immersive:not(.reading-tools-open) .topbar,
    body.reading-immersive:not(.reading-tools-open) .view-switch,
    body.reading-immersive:not(.reading-tools-open) .reader-toolbar,
    body.reading-immersive:not(.reading-tools-open) #bottomNav{display:none!important}
    body.reading-immersive:not(.reading-tools-open) .reader-view{padding:0}
    body.reading-immersive:not(.reading-tools-open) .reader-scroll{padding-bottom:0}
    body.reading-immersive:not(.reading-tools-open) .clean-reader{border:0;border-radius:0;box-shadow:none;padding:20px 18px 70px}
    body.reading-immersive:not(.reading-tools-open) .canvas-reader{border:0;border-radius:0;padding:0}
    body.reading-tools-open .reader-controls-toggle{bottom:calc(77px + env(safe-area-inset-bottom))}
    @media(max-width:420px){.library-home h2{font-size:19px}.library-home p{font-size:10px}}
'''

def replace_once(source: str, before: str, after: str, label: str) -> str:
    hits = source.count(before)
    if hits != 1:
        raise ValueError(f'{label}: esperado 1 trecho, encontrado {hits}. Projeto pode ter outra versão; nada foi modificado.')
    return source.replace(before, after, 1)

def replace_regex_once(source: str, regex: str, replacement: str, label: str) -> str:
    source, hits = re.subn(regex, lambda _: replacement, source, count=1, flags=re.S)
    if hits != 1:
        raise ValueError(f'{label}: trecho não encontrado. Nada foi modificado.')
    return source

def patch_index(source: str) -> str:
    if 'lume-offline-v5' in source or 'reader-controls-toggle' in source:
        raise ValueError('Este index.html aparentemente já possui a atualização do LUME.')
    s = source
    s = replace_once(s, '<meta name="theme-color" content="#0f172a" />',
        '<meta name="theme-color" content="#0f172a" />\n  <link rel="manifest" href="./manifest.webmanifest" />', 'Manifest PWA')
    s = replace_once(s, '<title>Leitor IA</title>', '<title>LUME — Leitor PDF</title>', 'Título')
    s = replace_once(s, '<h1>Leitor IA</h1>', '<h1>LUME</h1>', 'Marca do cabeçalho')
    s = replace_regex_once(s,
        r'      <div class="library-hero">.*?      </div>\n\n      <div class="library-tools">',
        '''      <div class="library-home">
        <div><div class="eyebrow">LUME • BIBLIOTECA</div><h2>Minha estante</h2><p>PDFs salvos no aparelho, acessíveis mesmo sem internet.</p></div>
        <button id="addPdfBtn" class="primary-btn" aria-label="Adicionar PDF à estante">＋ PDF</button>
        <input id="pdfInput" type="file" accept="application/pdf,.pdf" multiple hidden>
      </div>

      <div class="library-tools">''', 'Tela inicial simples')
    s = replace_once(s, '<label class="setting-row switch-row"><span>Mostrar páginas originais</span><input id="originalPage" type="checkbox"></label>',
                     '<input id="originalPage" type="checkbox" hidden>', 'Remover visualização original')
    s = replace_once(s, 'state.original=!!p.original;', 'state.original=false; // leitura limpa obrigatória', 'Padrão de leitura')
    s = replace_once(s,
       'import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";',
       'import * as pdfjsLib from "./assets/pdfjs/pdf.min.mjs";', 'Módulo PDF local')
    s = replace_once(s,
       'pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";',
       'pdfjsLib.GlobalWorkerOptions.workerSrc = "./assets/pdfjs/pdf.worker.min.mjs";', 'Worker PDF local')
    s = replace_once(s,
       "function getSelectedVoice(){const voices=speechSynthesis.getVoices();if(state.audio.voiceIndex==='auto')return bestVoice(voices);return voices[Number(state.audio.voiceIndex)]||bestVoice(voices)}",
       "function getSelectedVoice(){const all=speechSynthesis.getVoices();const voices=navigator.onLine?all:all.filter(v=>v.localService!==false);if(state.audio.voiceIndex==='auto')return bestVoice(voices);const selected=all[Number(state.audio.voiceIndex)];return selected&&voices.includes(selected)?selected:bestVoice(voices)}", 'Áudio voz offline')
    s = replace_once(s,
       "function startAudio(){const text=audioSourceText();if(!text)return alert('Aguarde o documento terminar de preparar a leitura.');speechSynthesis.cancel();",
       "function startAudio(){const text=audioSourceText();if(!text)return alert('Aguarde o documento terminar de preparar a leitura.');if(!navigator.onLine&&!getSelectedVoice()){updateAudioStatus('Nenhuma voz local disponível. Instale uma voz em português nas configurações de texto para fala do Android.');return}speechSynthesis.cancel();", 'Aviso voz não disponível')
    s = replace_once(s,
       '<div id="audioStatus" class="audio-status">O app prioriza automaticamente as melhores vozes em português disponíveis no aparelho.</div>',
       '<div id="audioStatus" class="audio-status">Sem internet, a leitura utiliza a voz de síntese de fala instalada no aparelho; vozes de nuvem exigem conexão.</div>', 'Orientação de áudio offline')
    s = replace_once(s,
       "function showView(view){const library=view==='library';$('#libraryView').classList.toggle('hidden',!library);$('#readerView').classList.toggle('hidden',library);$('#libraryTab').classList.toggle('active',library);$('#readerTab').classList.toggle('active',!library);$('#bottomNav').classList.toggle('hidden',library||!state.pdf);closePanel()}",
       "function showView(view){const library=view==='library';$('#libraryView').classList.toggle('hidden',!library);$('#readerView').classList.toggle('hidden',library);$('#libraryTab').classList.toggle('active',library);$('#readerTab').classList.toggle('active',!library);$('#bottomNav').classList.toggle('hidden',library||!state.pdf);document.body.classList.toggle('reading-immersive',!library&&!!state.pdf);document.body.classList.remove('reading-tools-open');$('#readerControlsToggle').setAttribute('aria-expanded','false');$('#readerControlsToggle').textContent='☰';closePanel()}", 'Tela cheia ao ler')
    s = replace_once(s, '  <nav id="bottomNav" class="bottom-nav hidden">',
       '  <button id="readerControlsToggle" class="reader-controls-toggle" type="button" aria-label="Mostrar ou recolher ferramentas de leitura" aria-expanded="false" title="Ferramentas">☰</button>\n\n  <nav id="bottomNav" class="bottom-nav hidden">', 'Botão para expandir')
    s = replace_once(s, "$('#addPdfBtn').onclick=()=>$('#pdfInput').click();",
       "$('#readerControlsToggle').onclick=()=>{const open=document.body.classList.toggle('reading-tools-open');$('#readerControlsToggle').setAttribute('aria-expanded',String(open));$('#readerControlsToggle').textContent=open?'×':'☰';if(!open)closePanel()};$('#addPdfBtn').onclick=()=>$('#pdfInput').click();", 'Abrir/ocultar painel')
    s = replace_once(s, '  </style>', STYLE + '  </style>', 'CSS tela cheia')
    s = replace_once(s,
       "loadPrefs();loadAISettings();refreshLibrary().catch(()=>{$('#shelf').innerHTML='<div class=\"empty-shelf\"><b>Não foi possível abrir a estante</b>O navegador bloqueou o armazenamento local.</div>'});showView('library');",
       "loadPrefs();loadAISettings();refreshLibrary().catch(()=>{$('#shelf').innerHTML='<div class=\"empty-shelf\"><b>Não foi possível abrir a estante</b>O navegador bloqueou o armazenamento local.</div>'});showView('library');if('serviceWorker' in navigator){window.addEventListener('load',()=>{navigator.serviceWorker.register('./service-worker.js').then(()=>navigator.serviceWorker.ready).then(reg=>reg.active?.postMessage({type:'CACHE_OFFLINE_ENGINE'})).catch(err=>console.warn('Cache offline indisponível:',err))})}", 'Registrar cache offline')
    return s

def download_pdf_engine(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    for filename, url in PDF_FILES.items():
        target = directory / filename
        if target.exists() and target.stat().st_size > 50000:
            print(f'PDF.js encontrado: {target.name}')
            continue
        print(f'Baixando PDF.js {filename}...')
        req = urllib.request.Request(url, headers={'User-Agent': 'LUME-Offline-Installer/1.0'})
        with urllib.request.urlopen(req, timeout=45) as response:
            data = response.read()
        if len(data) < 50000:
            raise RuntimeError(f'Arquivo PDF.js inválido: {filename} ({len(data)} bytes).')
        target.write_bytes(data)

def main():
    parser = argparse.ArgumentParser(description='Atualização offline do projeto LUME')
    parser.add_argument('repo', nargs='?', default='.', help='Pasta do repositório Leitor-IA')
    parser.add_argument('--no-download', action='store_true', help='Usar arquivos PDF.js já instalados em assets/pdfjs')
    args = parser.parse_args()
    root = Path(args.repo).expanduser().resolve()
    index = root / 'index.html'
    manifest = root / 'manifest.webmanifest'
    if not index.is_file() or not manifest.is_file():
        parser.error('A pasta informada não contém index.html e manifest.webmanifest do LUME.')
    original = index.read_text(encoding='utf-8')
    patched = patch_index(original)  # valida antes de alterar qualquer arquivo original
    if not args.no_download:
        download_pdf_engine(root / ASSET_DIR)
    for filename in PDF_FILES:
        target = root / ASSET_DIR / filename
        if not target.is_file() or target.stat().st_size < 50000:
            parser.error(f'PDF.js não encontrado: {target}. Instale os arquivos primeiro.')
    backup = root / 'index.html.lume-anterior.bak'
    if not backup.exists():
        shutil.copy2(index, backup)
    index.write_text(patched, encoding='utf-8')
    (root / 'service-worker.js').write_text(WORKER, encoding='utf-8')
    config = json.loads(manifest.read_text(encoding='utf-8'))
    config.update({'name':'LUME — Leitor PDF', 'short_name':'LUME', 'start_url':'./',
                   'description':'Biblioteca PDF com leitura limpa e áudio local, inclusive offline.'})
    manifest.write_text(json.dumps(config, indent=2, ensure_ascii=False)+'\n', encoding='utf-8')
    print('\nLUME atualizado com sucesso nesta pasta.')
    print('Arquivos alterados: index.html, manifest.webmanifest, service-worker.js, assets/pdfjs/*')
    print('Depois faça commit/push e abra uma vez online para ativar o cache offline no celular.')
    print('Observação: a voz offline depende de voz local instalada no Android; serviços de IA exigem internet.')

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'ERRO: {exc}', file=sys.stderr)
        sys.exit(1)
