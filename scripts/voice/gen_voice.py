# 혁게임 외침 음성 생성: MeloTTS 한국어 (MIT, myshell-ai/MeloTTS-Korean) → 무음 자르기·살짝 높이기·압축·음량 맞추기 → mp3 + webm(opus)
# 사용: (MeloTTS 설치된 venv에서) python scripts/voice/gen_voice.py [key ...]
import json, os, subprocess, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', '..', 'public', 'voice')
os.makedirs(OUT, exist_ok=True)
clips = {k: v for k, v in json.load(open(os.path.join(HERE, 'clips.json'))).items() if not k.startswith('_')}
only = sys.argv[1:]
from melo.api import TTS
m = TTS(language='KR', device='cpu')
spk = m.hps.data.spk2id['KR']
PITCH = float(os.environ.get('VOICE_PITCH', '1.06'))  # 살짝 높고 밝게 (포먼트 유지)
FILT = ','.join([
    'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.01',
    'areverse', 'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.04', 'areverse',
    f'rubberband=pitch={PITCH}:formant=preserved',
    'highpass=f=90', 'equalizer=f=2800:t=q:w=1.2:g=3.5',  # 또렷하게
    'acompressor=threshold=-20dB:ratio=4:attack=3:release=60:makeup=4',
    'loudnorm=I=-14:TP=-1.5:LRA=6',
    'apad=pad_dur=0.04', 'afade=t=in:d=0.005',
])
for k, (text, speed) in clips.items():
    if only and k not in only: continue
    import torch; torch.manual_seed(int(os.environ.get('VOICE_SEED', '7')))  # 같은 결과 재현
    with tempfile.TemporaryDirectory() as td:
        raw = os.path.join(td, 'raw.wav')
        m.tts_to_file(text, spk, raw, speed=speed, quiet=True)
        wav = os.path.join(td, 'p.wav')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw, '-af', FILT, '-ar', '44100', '-ac', '1', wav], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'libmp3lame', '-b:a', '48k', os.path.join(OUT, k + '.mp3')], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', wav, '-c:a', 'libopus', '-b:a', '28k', '-ar', '48000', os.path.join(OUT, k + '.webm')], check=True)
    print('ok', k, text)
man = {'version': 1, 'voice': 'MeloTTS-Korean KR (MIT) — 자체 생성', 'formats': ['webm', 'mp3'],
       'note': '직접 녹음으로 바꾸려면 같은 key 이름의 .mp3(필수)와 .webm(선택)을 넣으세요. webm이 없거나 재생이 안 되면 mp3를 씁니다.',
       'clips': {k: v[0] for k, v in clips.items()}}
json.dump(man, open(os.path.join(OUT, 'manifest.json'), 'w'), ensure_ascii=False, indent=1)
