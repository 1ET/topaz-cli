param([string]$InputFile,[string]$OutputFile)
$ErrorActionPreference='Stop'
$ffmpeg=$env:FFMPEG_PATH; $modelDir=$env:TVAI_MODEL_DIR
if(-not $ffmpeg -or -not (Test-Path $ffmpeg)){throw 'FFMPEG_PATH invalid'}
$env:TVAI_MODEL_DIR=$modelDir; $env:TVAI_MODEL_DATA_DIR=$modelDir
& $ffmpeg -hide_banner -y -hwaccel cuda -i $InputFile -filter_complex 'tvai_up=model=iris-3:scale=2:w=1280:h=720:device=0:vram=1:instances=0,scale=1280:720:flags=lanczos' -c:v h264_nvenc -preset p5 -cq 19 -pix_fmt yuv420p -c:a copy $OutputFile
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
