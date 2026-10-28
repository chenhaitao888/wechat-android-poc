"""Export only the scoped device credential. Never print secrets to the terminal."""
import argparse
import json
import os
from pathlib import Path
from channel_backend.network import device_config
from channel_backend.settings import load


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    os.umask(0o077)
    value=device_config(load())
    with args.output.open("x") as file:
        file.write(json.dumps(value,ensure_ascii=False,indent=2)+"\n")
    args.output.chmod(0o600)
    print("Device-only configuration exported. Transfer privately; do not commit it.")


if __name__=="__main__":main()
