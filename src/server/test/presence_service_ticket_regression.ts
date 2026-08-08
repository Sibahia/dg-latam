import { strict as assert } from 'assert';
import { PresenceService } from '../core/PresenceService';

function main(): void {
    const readTicket = PresenceService.buildServiceTicket('presence:read');
    assert.deepEqual(PresenceService.consumeServiceTicket(readTicket, 'presence:read'), { subject: '' });
    assert.equal(PresenceService.consumeServiceTicket(readTicket, 'presence:read'), null, 'service tickets must be one-time');

    const joinTicket = PresenceService.buildServiceTicket('presence:join', 'Requester');
    assert.deepEqual(PresenceService.consumeServiceTicket(joinTicket, 'presence:join'), { subject: 'requester' });
    assert.equal(
        PresenceService.consumeServiceTicket(
            PresenceService.buildServiceTicket('presence:read'),
            'presence:join'
        ),
        null,
        'read credentials must not authorize party mutations'
    );
    assert.equal(
        PresenceService.consumeServiceTicket(
            PresenceService.buildServiceTicket('presence:join'),
            'presence:join'
        ),
        null,
        'join credentials must be bound to a requester'
    );

    const joinSecret = PresenceService.buildDiscordJoinSecret(420, 'Leader');
    assert.ok(joinSecret);
    assert.deepEqual(PresenceService.resolveDiscordJoinSecret(joinSecret), {
        partyId: 420,
        partyLeader: 'leader'
    });
    assert.equal(PresenceService.resolveDiscordJoinSecret(joinSecret), null, 'join secrets must reject replay');
    assert.equal(PresenceService.resolveDiscordJoinSecret(`${joinSecret}x`), null, 'tampered secrets must be rejected');

    console.log('presence_service_ticket_regression: ok');
}

main();
