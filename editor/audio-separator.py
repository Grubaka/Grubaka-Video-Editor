"""Local Bandit v2 worker; never transmits the selected audio."""
import sys,json,os
from pathlib import Path
root=Path(__file__).resolve().parent
sys.path.insert(0,str(root/'vendor'))
def report(**values):print(json.dumps(values),flush=True)
def main():
    import numpy as np
    import soundfile as sf
    import torch
    from bandit_infer import BanditSession
    if sys.argv[1]=='check':
        report(ready=True,gpu=torch.cuda.is_available());return
    source,output,weights=sys.argv[1:4];folder=Path(output);folder.mkdir(exist_ok=True)
    torch.set_num_threads(min(8,os.cpu_count() or 4))
    audio,sr=sf.read(source,dtype='float32',always_2d=True)
    if sr!=48000:raise ValueError('Expected 48000 Hz')
    report(stage='loading')
    checkpoint=Path(weights)/'checkpoint-multi.ckpt'
    # Official SHA256 is verified by Bandit before weights-only deserialization.
    with BanditSession('v2-multi',family='v2',device='auto',checkpoint_path=checkpoint,checkpoint_sha256='abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc') as session:
        report(stage='separating',gpu=torch.cuda.is_available())
        handler=session._runtime.handler
        total=sum(i*handler.hop_size_samples+handler.chunk_size_samples>handler.front_pad_samples and i*handler.hop_size_samples<handler.front_pad_samples+len(audio) for i in range(handler._get_n_chunks(len(audio))))
        completed=0
        def step(*_):
            nonlocal completed
            completed+=1
            report(stage='separating',completed=completed,total=total)
        hook=session._runtime.model.register_forward_hook(step)
        try:stems=session.infer(audio.T,sample_rate=sr)
        finally:hook.remove()
        report(stage='saving')
        for name in ['speech','effects','music']:
            data=np.asarray(stems[name],dtype=np.float32)
            if data.ndim==1:data=data[None,:]
            if data.shape[-1]!=len(audio):raise ValueError('Separated audio has wrong length')
            if not np.isfinite(data).all():raise ValueError('Invalid separated samples')
            sf.write(folder/(name+'.wav'),data.T,sr,subtype='FLOAT')
    report(stage='done')
if __name__=='__main__':
    try:main()
    except Exception as exc:report(error=str(exc));raise
