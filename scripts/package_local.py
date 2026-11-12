from pathlib import Path
import argparse
import hashlib
import os
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
out = root / 'dist' / 'local-runner'
out.mkdir(parents=True, exist_ok=True)
parser = argparse.ArgumentParser()
parser.add_argument('--worker', action='store_true')
args = parser.parse_args()
kind = 'worker' if args.worker else 'local'
command = './cmd/worker' if args.worker else './cmd/local-runner'
for system in ['darwin', 'linux', 'windows']:
    for arch in ['arm64', 'amd64']:
        binary = f'llm-detector-{kind}' + ('.exe' if system == 'windows' else '')
        target = out / f'build-{system}-{arch}'
        subprocess.run(['go', 'build', '-trimpath', '-ldflags=-s -w', '-o', str(target), command], cwd=root, env={**os.environ, 'GOOS':system, 'GOARCH':arch, 'CGO_ENABLED':'0'}, check=True)
        archive = out / f'llm-detector-{kind}-{system}-{arch}.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
            info = zipfile.ZipInfo(binary)
            info.external_attr = 0o100755 << 16
            package.writestr(info, target.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
            script = 'start.cmd' if system == 'windows' else 'start.command' if system == 'darwin' else 'start.sh'
            body = f'@echo off\r\ncd /d "%~dp0"\r\n{binary}\r\npause\r\n' if system == 'windows' else f'#!/bin/sh\ncd "$(dirname "$0")"\nexec ./{binary}\n'
            info = zipfile.ZipInfo(script); info.external_attr = 0o100755 << 16
            package.writestr(info, body)
            readme = ('LLM Detector 自建 Worker\n运行 start 文件，首次启动生成 worker.env。\n默认监听127.0.0.1:9003；将该地址与 WORKER_KEY 填到网页。将网页来源加入 WORKER_ORIGINS。\n数据存于 worker-data，远程部署请设置 HTTPS 反向代理。\n' if args.worker else 'LLM Detector 本机 Worker\n解压后运行 start 文件，再在网页点击连接。本程序监听127.0.0.1:9002，配置与历史保存在浏览器。\n')
            package.writestr('README.txt', readme + 'Terminal Bench 需要 Docker、Git、Python 3.12 和 Harbor；Python / Harbor 可从网页安装。\n未签名开发构建，请通过可信来源校验下载。Windows Harbor 运行环境需单独验证。\n')
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
        target.unlink()
        print(f'Packaged {system}/{arch}', flush=True)
