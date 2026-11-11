from pathlib import Path
import hashlib
import os
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
out = root / 'dist' / 'local-runner'
out.mkdir(parents=True, exist_ok=True)
for system in ['darwin', 'linux', 'windows']:
    for arch in ['arm64', 'amd64']:
        binary = 'llm-detector-local.exe' if system == 'windows' else 'llm-detector-local'
        target = out / f'build-{system}-{arch}'
        subprocess.run(['go', 'build', '-trimpath', '-ldflags=-s -w', '-o', str(target), './cmd/local-runner'], cwd=root, env={**os.environ, 'GOOS':system, 'GOARCH':arch, 'CGO_ENABLED':'0'}, check=True)
        archive = out / f'llm-detector-local-{system}-{arch}.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
            info = zipfile.ZipInfo(binary)
            info.external_attr = 0o100755 << 16
            package.writestr(info, target.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
            script = 'start.cmd' if system == 'windows' else 'start.command' if system == 'darwin' else 'start.sh'
            body = '@echo off\r\ncd /d "%~dp0"\r\nllm-detector-local.exe\r\npause\r\n' if system == 'windows' else '#!/bin/sh\ncd "$(dirname "$0")"\nexec ./llm-detector-local\n'
            info = zipfile.ZipInfo(script); info.external_attr = 0o100755 << 16
            package.writestr(info, body)
            package.writestr('README.txt', 'LLM Detector 本机执行器\n解压并启动本机程序，将控制台配对码填入网页。本程序仅监听127.0.0.1:9002。\n指纹检测无需Python；Terminal Bench请在页面点击安装Harbor依赖，并安装/启动Docker与Git。\n依赖缓存位于用户缓存目录，任务临时文件在完成或正常退出后清理。\n未签名开发构建，请通过可信来源核验SHA256后按操作系统提示启动。Windows上的Harbor环境需单独验证。\n')
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
        target.unlink()
        print(f'Packaged {system}/{arch}', flush=True)
