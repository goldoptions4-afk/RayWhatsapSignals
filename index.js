const express = require('express')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const QRCode = require('qrcode')
const https = require('https')
const http = require('http')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const AUTH_DIR = '/app/wa_auth'

const TARGET_GROUPS = [
    'PREMIUM GOLD GROUP',
    'GOLD | BITCOIN | SIGNALS GROUP',
    'WINNERS GOLD SIGNAL',
    "Kevin's GOLD & BTC SIGNALS"
]

// Hardcoded JIDs — announcement channels for communities, direct JID for regular groups
const HARDCODED_JIDS = {
    'PREMIUM GOLD GROUP':           '120363414747612793@g.us', // announcement channel
    'WINNERS GOLD SIGNAL':          '120363393171612639@g.us', // announcement channel
    'GOLD | BITCOIN | SIGNALS GROUP': '120363406855804020@g.us', // regular group
    "Kevin's GOLD & BTC SIGNALS":   '120363401990805201@g.us'  // regular group
}

let sock = null
let qrCode = null
let isConnected = false
let groupJids = {}

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
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000)
        }

        if (connection === 'open') {
            console.log('✅ WhatsApp connected!')
            isConnected = true
            qrCode = null
            await findTargetGroups()
        }
    })
}

async function findTargetGroups() {
    // Use hardcoded JIDs directly — no scanning needed
    groupJids = {}
    for (const [name, jid] of Object.entries(HARDCODED_JIDS)) {
        groupJids[name] = jid
        console.log(`📌 Hardcoded: "${name}" (${jid})`)
    }
    console.log('✅ All groups loaded from hardcoded JIDs')
}

async function fetchImageBuffer(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http
        client.get(url, (res) => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => resolve(Buffer.concat(chunks)))
            res.on('error', reject)
        }).on('error', reject)
    })
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
    const { message, group, image_url } = req.body
    if (!message) return res.status(400).json({ error: 'no message' })
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp not connected' })

    if (Object.keys(groupJids).length === 0) await findTargetGroups()

    const targets = group
        ? Object.entries(groupJids).filter(([name]) => name === group)
        : Object.entries(groupJids)

    if (group && targets.length === 0) {
        console.log(`⚠️ Group not found: "${group}"`)
        return res.status(404).json({ error: `group not found: ${group}` })
    }

    // Fetch image if provided
    let imageBuffer = null
    if (image_url) {
        try {
            imageBuffer = await fetchImageBuffer(image_url)
            console.log(`📷 Image fetched: ${image_url}`)
        } catch (err) {
            console.log(`⚠️ Could not fetch image, sending text only: ${err.message}`)
        }
    }

    const results = {}
    for (const [name, jid] of targets) {
        try {
            if (imageBuffer) {
                await sock.sendMessage(jid, { image: imageBuffer, caption: message })
            } else {
                await sock.sendMessage(jid, { text: message })
            }
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

app.get('/list-groups-full', async (req, res) => {
    try {
        const groups = await sock.groupFetchAllParticipating()
        const list = Object.entries(groups).map(([jid, g]) => ({
            jid,
            name: g.subject,
            isCommunity: g.isCommunity,
            isCommunityAnnounce: g.isCommunityAnnounce,
            linkedParent: g.linkedParent
        }))
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
