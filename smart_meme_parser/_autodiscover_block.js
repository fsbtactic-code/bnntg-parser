    try {
        const seenStats   = getSeenInStats();
        const CONFIG_PATH = './config.json';
        const cfgRaw      = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const existingSet = new Set(
            (cfgRaw.targetChannels || cfgRaw.channels || []).map(c => String(c).toLowerCase().replace('@','').trim())
        );
        const destChannels = new Set(
            [cfgRaw.destinationChannel, ...(cfgRaw.destinationChannels || [])]
                .filter(Boolean).map(c => String(c).toLowerCase().replace('@',''))
        );

        const autoAdded = [];
        for (const [ch, hits] of Object.entries(seenStats)) {
            if (hits < 5)             continue; // min 5 reposts
            if (existingSet.has(ch))  continue; // already tracked
            if (destChannels.has(ch)) continue; // our destination

            // Step 1: get info from cache or HTTP
            let entityEntry = entityCache[ch] || entityCache['@' + ch];
            let scEntry     = subsCache[ch];
            if (!scEntry || !scEntry.subs || !entityEntry || !entityEntry.title) {
                const info = await fetchChannelInfoHTTP(ch);
                if (info) {
                    entityEntry = { id: '', accessHash: '', title: info.title || '' };
                    entityCache[ch] = entityEntry;
                    scEntry = { subs: info.subs || 0, desc: info.desc || '' };
                    subsCache[ch] = scEntry;
                    fs.writeFileSync(cachePath, JSON.stringify(subsCache));
                    saveEntityCache();
                } else continue;
            }

            // Step 2: meme keyword in username / title / description
            const chTitle  = entityEntry ? (entityEntry.title || '') : '';
            const chDesc   = scEntry ? (scEntry.desc || '') : '';
            const isMemeKW = /mem|\u043c\u0435\u043c/i.test(ch) || /mem|\u043c\u0435\u043c/i.test(chTitle) || /mem|\u043c\u0435\u043c/i.test(chDesc);
            if (!isMemeKW) continue;

            // Step 3: subscriber range 1000-20000
            const subs = scEntry ? (scEntry.subs > 0 ? scEntry.subs : parseRawSubs(scEntry.rawSubs)) : 0;
            if (subs < 1000 || subs > 20000) continue;

            // Step 3.5: exclude words in title/desc
            const excludeRegex = /anime|animе|аниме|\bарт\b|\bарты\b|архитек/i;
            if (excludeRegex.test(chTitle) || excludeRegex.test(chDesc) || excludeRegex.test(ch)) continue;

            // Step 4: check format via TG GetHistory (20 recent posts)
            let checkPeer = null;
            if (entityEntry && entityEntry.id && entityEntry.accessHash) {
                try {
                    checkPeer = new Api.InputPeerChannel({
                        channelId: BigInt(entityEntry.id),
                        accessHash: BigInt(entityEntry.accessHash)
                    });
                } catch(_e1) {}
            }
            if (!checkPeer) {
                try {
                    const ent = await client.getEntity(ch);
                    if (ent && ent.id && ent.accessHash != null) {
                        entityCache[ch] = { id: ent.id.toString(), accessHash: ent.accessHash.toString(), title: ent.title || '' };
                        saveEntityCache();
                        checkPeer = new Api.InputPeerChannel({
                            channelId: BigInt(ent.id.toString()),
                            accessHash: BigInt(ent.accessHash.toString())
                        });
                        if (ent.participantsCount > 0) {
                            subsCache[ch] = subsCache[ch] || {};
                            subsCache[ch].subs = ent.participantsCount;
                            fs.writeFileSync(cachePath, JSON.stringify(subsCache));
                        }
                    }
                } catch(_e2) {}
            }

            let isMemeFormat = false;
            if (checkPeer) {
                try {
                    const hist = await client.invoke(new Api.messages.GetHistory({
                        peer: checkPeer, limit: 20, offsetId: 0,
                        offsetDate: 0, addOffset: 0, maxId: 0, minId: 0, hash: BigInt(0)
                    }));
                    const msgs = (hist.messages || []).filter(m => m.className === 'Message');
                    if (msgs.length >= 5) {
                        let total = 0, singleMedia = 0, longText = 0;
                        for (const m of msgs) {
                            total++;
                            const cls   = (m.media && m.media.className) ? m.media.className : '';
                            const doc   = (m.media && m.media.document) ? m.media.document : null;
                            const mime  = doc ? (doc.mimeType || '') : '';
                            const attrs = doc ? (doc.attributes || []) : [];

                            // groupedId is Long in gramJS — album if non-null and non-zero
                            const gid     = m.groupedId;
                            const isAlbum = (gid != null && gid.toString() !== '0');

                            const isPhoto   = (cls === 'MessageMediaPhoto');
                            const isGif     = attrs.some(a => a.className === 'DocumentAttributeAnimated');
                            const isVideo   = (cls === 'MessageMediaDocument') && (mime.startsWith('video/') || isGif);
                            const isVoice   = attrs.some(a => a.className === 'DocumentAttributeAudio' && a.voice);
                            const isSticker = attrs.some(a => a.className === 'DocumentAttributeSticker');
                            const isAudio   = !isGif && (mime.startsWith('audio/') || mime === 'video/ogg');

                            // Single media: photo or video/gif, NOT album, NOT voice/sticker/audio
                            if ((isPhoto || isVideo) && !isAlbum && !isVoice && !isSticker && !isAudio) singleMedia++;
                            // Long caption > 100 chars
                            if ((m.message || '').trim().length > 100) longText++;
                        }
                        // Strict: >=85% single-media posts AND <15% long-text posts
                        isMemeFormat = (total >= 5) && ((singleMedia / total) >= 0.85) && ((longText / total) < 0.15);
                    }
                    await new Promise(r => setTimeout(r, 300));
                } catch(_e3) {}
            }

            // Step 5: add to targetChannels ONLY if passed format check
            if (!isMemeFormat) continue;

            existingSet.add(ch);
            if (cfgRaw.targetChannels) cfgRaw.targetChannels.push(ch);
            else if (cfgRaw.channels)  cfgRaw.channels.push(ch);

            if (isMemeFormat) {
                if (!cfgRaw.tags) cfgRaw.tags = {};
                cfgRaw.tags[ch] = Array.from(new Set((cfgRaw.tags[ch] || []).concat('meme_format')));
                try {
                    const discPath = './discovered_channels.json';
                    if (fs.existsSync(discPath)) {
                        const discData = JSON.parse(fs.readFileSync(discPath, 'utf8'));
                        const entry = discData.find(x => (x.username || '').toLowerCase().replace('@','') === ch);
                        if (entry) {
                            entry.tags = Array.from(new Set((entry.tags || []).concat('meme_format')));
                            entry.isMeme = true;
                        }
                        fs.writeFileSync(discPath, JSON.stringify(discData, null, 2));
                    }
                } catch(_e4) {}
            }

            const inTitle = /mem|\u043c\u0435\u043c/i.test(chTitle);
            const label = isMemeFormat ? ' [\ud83c\udff7 meme_format \u2705]' : '';
            autoAdded.push('@' + ch + ' (' + subs + ' \u043f\u043e\u0434\u043f., reposts: ' + hits + (inTitle ? ' "' + chTitle + '"' : '') + ')' + label);
        }

        if (autoAdded.length > 0) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfgRaw, null, 4));
            console.log('\n\ud83e\udd16 \u0410\u0432\u0442\u043e-\u0434\u043e\u0431\u0430\u0432\u043b\u0435\u043d\u043e ' + autoAdded.length + ' \u043c\u0435\u043c-\u043a\u0430\u043d\u0430\u043b(\u043e\u0432) \u0432 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0438:');
            autoAdded.forEach(x => console.log('  \u271a ' + x));
        }
    } catch(e) {
        console.log('\u26a0\ufe0f autoDiscover error:', e.message);
    }
