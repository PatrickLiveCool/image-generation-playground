#!/usr/bin/python3
"""Root-owned forced command. No shell, forwarding, arbitrary paths or environment."""
import os
import re
import subprocess
import sys


def parse_command(original):
    version = r'v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)'
    match = re.fullmatch(rf'(deploy|rollback) ({version}) ([0-9a-f]{{40}}) (qintopia-image/releases/{version}/[0-9a-f]{{40}}/) ([0-9a-f]{{64}})', original)
    if match:
        operation, tag, revision, prefix, checksum = match.groups()
        if prefix != f'qintopia-image/releases/{tag}/{revision}/':
            raise ValueError('invalid release identity')
        return [operation, tag, revision, prefix, checksum]
    if original in ['status', 'maintenance', 'maintenance dry-run', 'maintenance apply']:
        return original.split(' ')
    raise ValueError('restricted image release command required')


def main():
    if sys.argv[1:]:
        sys.exit('invalid SSH entry mode')
    try:
        arguments = parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    except ValueError:
        sys.exit('restricted image release command required')
    result = subprocess.run(['sudo', '-n', '/usr/local/sbin/qintopia-image-deploy', *arguments],
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}, check=False)
    sys.exit(result.returncode)


if __name__ == '__main__':
    main()
