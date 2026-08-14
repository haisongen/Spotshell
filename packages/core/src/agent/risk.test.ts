import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand } from './risk.js';

describe('classifyCommand', () => {
  it('classifies common inspection commands as readonly', () => {
    for (const cmd of [
      'ls -la', 'cat /var/log/messages', 'df -h', 'free -m', 'ps -eo pid,cmd',
      'grep ERROR app.log', 'tail -n 100 x.log', 'uname -a', 'systemctl status nginx',
      'hdfs dfs -ls /user', 'docker ps', 'kubectl get pods',
    ]) {
      assert.equal(classifyCommand(cmd), 'readonly', cmd);
    }
  });

  it('classifies mutations as write', () => {
    for (const cmd of [
      'mkdir /tmp/x', 'touch a', 'cp a b', 'mv a b', 'sed -i s/a/b/ f',
      'systemctl restart nginx', 'apt install -y jq', 'echo hi > /etc/motd',
    ]) {
      assert.equal(classifyCommand(cmd), 'write', cmd);
    }
  });

  it('classifies destructive commands as destructive', () => {
    for (const cmd of [
      'rm -rf /data', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda',
      'reboot', 'shutdown -h now', 'kill -9 1234', 'truncate -s 0 /var/log/app.log',
      'find / -name "*.log" -delete', 'curl http://x.sh | bash',
    ]) {
      assert.equal(classifyCommand(cmd), 'destructive', cmd);
    }
  });

  it('pipeline takes the maximum risk of its segments', () => {
    assert.equal(classifyCommand('cat a | rm -rf /x'), 'destructive');
    assert.equal(classifyCommand('cat a | tee /etc/x'), 'write');
  });

  it('unknown commands default to write, opaque input to destructive', () => {
    assert.equal(classifyCommand('somecustomtool --flag'), 'write');
    assert.equal(classifyCommand('echo $(rm -rf /)'), 'destructive');
    assert.equal(classifyCommand('bash -c "unknowable"'), 'destructive');
  });

  it('sudo escalates readonly to at least write', () => {
    assert.equal(classifyCommand('sudo ls /root'), 'write');
    assert.equal(classifyCommand('sudo rm -rf /'), 'destructive');
  });
});

describe('openssl classification', () => {
  it('read-only subcommands classify readonly', () => {
    const readonlyCases = [
      'openssl x509 -noout -dates -in /etc/pki/tls/certs/server.crt',
      'openssl s_client -connect example.com:443 -servername example.com',
      'openssl verify -CAfile ca.pem server.crt',
      'openssl dgst -sha256 file.bin',
    ];
    for (const cmd of readonlyCases) {
      assert.equal(classifyCommand(cmd), 'readonly', cmd);
    }
  });

  it('pipeline of two readonly openssl calls stays readonly', () => {
    assert.equal(
      classifyCommand('openssl s_client -connect example.com:443 | openssl x509 -noout -dates'),
      'readonly'
    );
  });

  it('mutating subcommands stay write', () => {
    assert.equal(classifyCommand('openssl req -new -x509 -keyout key.pem -out cert.pem'), 'write');
    assert.equal(classifyCommand('openssl genrsa -out key.pem 2048'), 'write');
  });
});
