// LUME APK: o WebView do Android não fala pela Web Speech API.
// Este arquivo substitui speechSynthesis/SpeechSynthesisUtterance pela voz nativa
// do Android (plugin @capacitor-community/text-to-speech). No navegador não faz nada.
(function () {
  var C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  var T = C.Plugins && C.Plugins.TextToSpeech;
  if (!T) return;

  var voices = [], current = null, speaking = false, paused = false, token = 0;

  function Utterance(text) {
    this.text = text || ''; this.lang = 'pt-BR'; this.rate = 1; this.pitch = 1; this.volume = 1;
    this.voice = null; this.onstart = null; this.onend = null; this.onerror = null;
  }

  function run(u, my, resumed) {
    var opts = { text: u.text, lang: (u.voice && u.voice.lang) || u.lang || 'pt-BR',
      rate: u.rate || 1, pitch: u.pitch || 1, volume: u.volume == null ? 1 : u.volume, category: 'playback' };
    var idx = u.voice ? voices.indexOf(u.voice) : -1;
    if (idx >= 0) opts.voice = idx;
    if (!resumed && u.onstart) { try { u.onstart({}); } catch (e) {} }
    T.speak(opts).then(function () {
      if (my !== token) return;
      speaking = false; current = null;
      if (u.onend) u.onend({});
    }).catch(function (e) {
      if (my !== token) return;
      speaking = false; current = null;
      if (u.onerror) u.onerror({ error: String((e && e.message) || e) });
    });
  }

  var synth = {
    onvoiceschanged: null,
    get speaking() { return speaking; },
    get paused() { return paused; },
    get pending() { return false; },
    getVoices: function () { return voices; },
    speak: function (u) { var my = ++token; current = u; speaking = true; paused = false; run(u, my, false); },
    cancel: function () { token++; current = null; speaking = false; paused = false; T.stop().catch(function () {}); },
    pause: function () { if (!speaking || paused) return; paused = true; token++; T.stop().catch(function () {}); },
    resume: function () { if (!paused || !current) return; paused = false; var my = ++token; run(current, my, true); }
  };

  try { Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true }); }
  catch (e) { window.speechSynthesis = synth; }
  window.SpeechSynthesisUtterance = Utterance;

  T.getSupportedVoices().then(function (r) {
    voices = (r && r.voices) || [];
    if (typeof synth.onvoiceschanged === 'function') synth.onvoiceschanged();
  }).catch(function () {});
})();
