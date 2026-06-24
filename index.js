const express = require('express')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const QRCode = require('qrcode')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const AUTH_DIR = '/app/wa_auth'

// All target groups/communities to send to
const TARGET_GROUPS = [
    'PREMIUM GOLD GROUP',
    'GOLD | BITCOIN | SIGNALS GROUP',
    'WINNERS GOLD SIGNAL',
    "Kevin's GOLD & BTC SIGNALS"
]

let sock = null
let qrCode = null
let isConnected = false
let groupJids = {} // { groupName: jid }

// ─────────────────────────────────────────────
// WHATSAPP CONNECTION
// ─────────────────────────────────────────────

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
    const { version } = await fetchLatestBaileysVersion()

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state,
        browser: ['RayGoldSignals', 'Chrome', '1.0.0'],
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('📱 QR code generated — scan it!')
            qrCode = await QRCode.toDataURL(qr)
            isConnected = false
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('❌ Connection closed. Reconnecting:', shouldReconnect)
            isConnected = false
            qrCode = null
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000)
            }
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connected!')
            isConnected = true
            qrCode = null
            await findTargetGroups()
        }
    })
}

// Hardcoded JID for Kevin GOLD & BTC SIGNALS group (joined via invite link)
const KEVIN_GOLD_JID = process.env.KEVIN_GOLD_JID || ''

async function findTargetGroups() {
    try {
        groupJids = {}
        const groups = await sock.groupFetchAllParticipating()
        for (const [jid, group] of Object.entries(groups)) {
            const name = group.subject?.trim()
            console.log(`📋 Group: "${name}" (${jid})`)
            if (TARGET_GROUPS.includes(name)) {
                groupJids[name] = jid
                console.log(`✅ Found: "${name}" (${jid})`)
            }
        }
        // Try to get Kevin GOLD group via invite link if not found
        if (!groupJids["Kevin's GOLD & BTC SIGNALS"]) {
            try {
                const info = await sock.groupGetInviteInfo('IkmwitDmS5D3vWo8fN6Mhj')
                if (info && info.id) {
                    groupJids["Kevin's GOLD & BTC SIGNALS"] = info.id
                    console.log(`✅ Found via invite: Kevin's GOLD & BTC SIGNALS (${info.id})`)
                }
            } catch(e) {
                console.log('⚠️ Could not get group via invite:', e.message)
            }
        }
        const found = Object.keys(groupJids)
        const missing = TARGET_GROUPS.filter(g => !found.includes(g))
        if (missing.length > 0) {
            console.log(`⚠️ Not found: ${missing.join(', ')}`)
        }
    } catch (err) {
        console.error('❌ Error finding groups:', err.message)
    }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get('/qr', async (req, res) => {
    if (isConnected) {
        const foundGroups = Object.entries(groupJids).map(([name, jid]) => `${name}: ${jid}`).join('<br>')
        const missing = TARGET_GROUPS.filter(g => !groupJids[g])
        return res.send(`
            <html><body style="font-family:Arial;text-align:center;padding:50px">
            <h2>✅ WhatsApp Connected!</h2>
            <h3>Groups found:</h3>
            <p>${foundGroups || 'Still searching...'}</p>
            ${missing.length ? `<h3>⚠️ Not found:</h3><p>${missing.join(', ')}</p>` : ''}
            </body></html>
        `)
    }
    if (qrCode) {
        return res.send(`
            <html><body style="font-family:Arial;text-align:center;padding:50px">
            <h2>📱 Scan QR Code with WhatsApp</h2>
            <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
            <img src="${qrCode}" style="width:300px;height:300px"/>
            <p>Refresh this page after scanning</p>
            </body></html>
        `)
    }
    return res.send(`
        <html><body style="font-family:Arial;text-align:center;padding:50px">
        <h2>⏳ Generating QR code...</h2>
        <p>Please wait a few seconds and refresh</p>
        </body></html>
    `)
})

app.post('/send', async (req, res) => {
    const { message, group } = req.body
    if (!message) return res.status(400).json({ error: 'no message' })
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp not connected' })

    if (Object.keys(groupJids).length === 0) {
        await findTargetGroups()
    }

    // If a specific group is requested, only send to that one
    const targets = group
        ? Object.entries(groupJids).filter(([name]) => name === group)
        : Object.entries(groupJids)

    if (group && targets.length === 0) {
        console.log(`⚠️ Group not found: "${group}"`)
        return res.status(404).json({ error: `group not found: ${group}` })
    }

    const results = {}
    for (const [name, jid] of targets) {
        try {
            await sock.sendMessage(jid, { text: message })
            results[name] = 'sent ✅'
            console.log(`✅ Sent to: ${name}`)
        } catch (err) {
            results[name] = `failed ❌: ${err.message}`
            console.error(`❌ Failed to send to ${name}:`, err.message)
        }
    }

    return res.json({ status: 'ok', results })
})

app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        groups: groupJids,
        missing: TARGET_GROUPS.filter(g => !groupJids[g])
    })
})

app.get('/list-groups', async (req, res) => {
    try {
        const groups = await sock.groupFetchAllParticipating()
        const list = Object.values(groups).map(g => g.subject)
        res.json({ total: list.length, groups: list })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get('/refresh-groups', async (req, res) => {
    await findTargetGroups()
    res.json({ groups: groupJids, missing: TARGET_GROUPS.filter(g => !groupJids[g]) })
})

app.get('/', (req, res) => {
    res.json({ status: 'RayWhatsApp running ✅', connected: isConnected, groups: Object.keys(groupJids) })
})

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`🚀 RayWhatsApp server running on port ${PORT}`)
    connectToWhatsApp()
})
