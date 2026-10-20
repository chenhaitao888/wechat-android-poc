#!/usr/bin/env python3
"""Build with pinned Google SDK archives; no Gradle or external libraries."""
from pathlib import Path
import os, subprocess, zipfile, shutil, secrets, hashlib, json
app=Path(__file__).resolve().parent
root=app.parent
sdk=root/'vendor/sdk'
jar=sdk/'android-35/android.jar'
tools=sdk/'android-15'
java=Path(subprocess.check_output(['/usr/libexec/java_home'],text=True).strip())/'bin'
build=app/'build'
for name in ['compiled','generated','classes','dex']: (build/name).mkdir(parents=True,exist_ok=True)
def run(args): subprocess.run([str(v) for v in args], check=True)
run([tools/'aapt2','compile','--dir',app/'res','-o',build/'resources.zip'])
run([tools/'aapt2','link','-I',jar,'--manifest',app/'AndroidManifest.xml','--java',build/'generated','-o',build/'base.apk',build/'resources.zip'])
sources=list((app/'src').rglob('*.java'))+list((build/'generated').rglob('*.java'))
run([java/'javac','--release','8','-encoding','UTF-8','-classpath',jar,'-d',build/'classes',*sources])
run([java/'java','-cp',tools/'lib/d8.jar','com.android.tools.r8.D8','--min-api','30','--lib',jar,'--output',build/'dex',*list((build/'classes').rglob('*.class'))])
with zipfile.ZipFile(build/'base.apk','a',zipfile.ZIP_DEFLATED) as apk:
    for dex in (build/'dex').glob('*.dex'): apk.write(dex,dex.name)
run([tools/'zipalign','-f','4',build/'base.apk',build/'aligned.apk'])
keydir=app/'.signing'
keydir.mkdir(mode=0o700,exist_ok=True)
password_file=keydir/'password'
keyfile=keydir/'development.p12'
if not password_file.exists():
    password_file.write_text(secrets.token_urlsafe(32)); password_file.chmod(0o600)
if not keyfile.exists():
    run([java/'keytool','-genkeypair','-keystore',keyfile,'-storetype','PKCS12','-storepass:file',password_file,'-alias','local-test','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=Local WeChat Test'])
    keyfile.chmod(0o600)
output=build/'wechat-accessibility-helper.apk'
run([java/'java','-jar',tools/'lib/apksigner.jar','sign','--ks',keyfile,'--ks-pass','file:'+str(password_file),'--ks-key-alias','local-test','--out',output,build/'aligned.apk'])
run([java/'java','-jar',tools/'lib/apksigner.jar','verify','--verbose',output])
print(json.dumps({'apk':str(output),'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'bytes':output.stat().st_size}))
