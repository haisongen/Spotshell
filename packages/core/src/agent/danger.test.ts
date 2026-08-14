import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDangerousCommand } from './danger.js';

describe('isDangerousCommand', () => {
  it('flags rm -rf', () => {
    assert.equal(isDangerousCommand('rm -rf /var/tmp/x'), true);
  });

  it('flags reboot and kill -9', () => {
    assert.equal(isDangerousCommand('sudo reboot'), true);
    assert.equal(isDangerousCommand('kill -9 1234'), true);
  });

  it('allows safe read commands', () => {
    assert.equal(isDangerousCommand('free -m'), false);
    assert.equal(isDangerousCommand('df -h'), false);
  });
});
