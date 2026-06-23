const express = require('express')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const QRCode = require('qrcode')
const fs = require('fs')
const path = require('path')

const app = express()
app.use(express.json())

const PORT = process.env.PORT || 3000
const TARGET_GROUP = process.env.TARGET_GROUP || 'Dummy to clients'
const AUTH_DIR = '/tmp/wa_auth'

let sock = null
let qrCode = null
let isConnected = false
let groupJid = null

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
            // Find the target group
            await findTargetGroup()
        }
    })
}

async function findTargetGroup() {
    try {
        const groups = await sock.groupFetchAllParticipating()
        for (const [jid, group] of Object.entries(groups)) {
            if (group.subject === TARGET_GROUP) {
                groupJid = jid
                console.log(`✅ Found group: ${TARGET_GROUP} (${jid})`)
                return
            }
        }
        console.log(`⚠️ Group "${TARGET_GROUP}" not found`)
        console.log('Available groups:', Object.values(groups).map(g => g.subject))
    } catch (err) {
        console.error('❌ Error finding group:', err.message)
    }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// QR code page — scan this to connect WhatsApp
app.get('/qr', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <html><body style="font-family:Arial;text-align:center;padding:50px">
            <h2>✅ WhatsApp Connected!</h2>
            <p>Group: ${TARGET_GROUP}</p>
            <p>Group JID: ${groupJid || 'Still finding...'}</p>
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

// Send message to group
app.post('/send', async (req, res) => {
    const { message } = req.body

    if (!message) {
        return res.status(400).json({ error: 'no message provided' })
    }

    if (!isConnected) {
        return res.status(503).json({ error: 'WhatsApp not connected' })
    }

    if (!groupJid) {
        // Try to find the group again
        await findTargetGroup()
        if (!groupJid) {
            return res.status(404).json({ error: `Group "${TARGET_GROUP}" not found` })
        }
    }

    try {
        await sock.sendMessage(groupJid, { text: message })
        console.log(`✅ Message sent to ${TARGET_GROUP}`)
        return res.json({ status: 'ok', group: TARGET_GROUP })
    } catch (err) {
        console.error('❌ Send error:', err.message)
        return res.status(500).json({ error: err.message })
    }
})

// Status check
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        group: TARGET_GROUP,
        groupJid: groupJid || 'not found',
        hasQR: !!qrCode
    })
})

// Refresh group list
app.get('/refresh-groups', async (req, res) => {
    await findTargetGroup()
    res.json({ groupJid, group: TARGET_GROUP })
})

app.get('/', (req, res) => {
    res.json({ status: 'RayWhatsApp running ✅', connected: isConnected })
})

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`🚀 RayWhatsApp server running on port ${PORT}`)
    connectToWhatsApp()
})
