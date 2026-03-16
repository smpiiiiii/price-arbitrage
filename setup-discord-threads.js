/**
 * Discordチャンネルにスレッドを作成するスクリプト
 * 
 * Webhook URLからチャンネルIDを取得し、
 * Discord APIでスレッドを作成する。
 * 
 * ※ Webhookではスレッド作成ができないため、
 *    Webhook経由でメッセージを投稿し、
 *    そのメッセージからスレッドを開始する。
 */

import 'dotenv/config';

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

async function createThread(threadName, emoji) {
    // Webhookで初回メッセージを投稿（?wait=trueでメッセージIDを取得）
    const res = await fetch(`${WEBHOOK_URL}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: `${emoji} Price Alert セットアップ`,
            content: `**${threadName}**\nこのスレッドに${threadName}の通知が送信されます。`,
        }),
    });

    if (!res.ok) {
        console.error(`❌ メッセージ送信失敗: ${res.status} ${await res.text()}`);
        return null;
    }

    const message = await res.json();
    console.log(`✅ メッセージ送信完了: ID=${message.id}, チャンネル=${message.channel_id}`);

    // メッセージからスレッドを作成
    const threadRes = await fetch(`https://discord.com/api/v10/channels/${message.channel_id}/messages/${message.id}/threads`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // ※ BOTトークンが必要 — Webhookだけでは作成不可
            // 'Authorization': `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        },
        body: JSON.stringify({
            name: threadName,
            auto_archive_duration: 10080, // 7日
        }),
    });

    if (!threadRes.ok) {
        // BOTトークンなしではスレッド作成は不可
        // 代替: フォーラムチャンネルでthread_nameを使用
        console.log(`⚠️ スレッド自動作成にはBOTトークンが必要です`);
        console.log(`   代替方法:`);
        console.log(`   1. Discordで手動でスレッドを作成`);
        console.log(`   2. スレッドIDを.envに設定`);
        console.log(`   3. またはチャンネルをフォーラムに変更`);
        return { messageId: message.id, channelId: message.channel_id, needsManualSetup: true };
    }

    const thread = await threadRes.json();
    console.log(`✅ スレッド作成完了: "${threadName}" ID=${thread.id}`);
    return { threadId: thread.id, channelId: message.channel_id };
}

async function main() {
    console.log('🔧 Discord スレッドセットアップ\n');

    if (!WEBHOOK_URL) {
        console.error('❌ DISCORD_WEBHOOK_URL が設定されていません');
        process.exit(1);
    }

    // Webhook情報を取得
    const webhookInfo = await fetch(WEBHOOK_URL);
    if (!webhookInfo.ok) {
        console.error('❌ Webhook情報取得失敗');
        process.exit(1);
    }
    const info = await webhookInfo.json();
    console.log(`📌 Webhook: ${info.name}`);
    console.log(`📌 チャンネルID: ${info.channel_id}`);
    console.log(`📌 ギルドID: ${info.guild_id}\n`);

    // フォーラムチャンネルかどうかはWebhookからは判別不可
    // thread_name方式を試してみる
    console.log('🧪 フォーラムチャンネル方式を試行中...\n');

    // スニダンアラート用のメッセージを送信 (thread_name)
    const snkrdunkRes = await fetch(`${WEBHOOK_URL}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            username: '👟 スニダンアラート v3',
            avatar_url: 'https://cdn-icons-png.flaticon.com/512/2589/2589903.png',
            thread_name: '👟 スニダンアラート',
            embeds: [{
                title: '👟 スニダンアラート — スレッド開設',
                description: 'このスレッドにスニダンモニターの通知が送信されます。\n\n**データソース**: スニダン × 楽天 × Yahoo × メルカリ',
                color: 0xf97316,
                timestamp: new Date().toISOString(),
            }],
        }),
    });

    if (snkrdunkRes.ok) {
        const msg = await snkrdunkRes.json();
        console.log(`✅ スニダンスレッド作成成功! ID=${msg.channel_id}`);
        console.log(`   → .env に追加: DISCORD_SNKRDUNK_THREAD_ID=${msg.channel_id}\n`);

        // eBayアービトラージ用
        await new Promise(r => setTimeout(r, 2000));
        const ebayRes = await fetch(`${WEBHOOK_URL}?wait=true`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: '💰 Price Alert v4',
                avatar_url: 'https://cdn-icons-png.flaticon.com/512/2331/2331941.png',
                thread_name: '💰 eBayアービトラージ',
                embeds: [{
                    title: '💰 eBayアービトラージ — スレッド開設',
                    description: 'このスレッドにeBayモニターの通知が送信されます。\n\n**データソース**: eBay Browse API × 楽天 × Sold Listings',
                    color: 0x6366f1,
                    timestamp: new Date().toISOString(),
                }],
            }),
        });

        if (ebayRes.ok) {
            const ebayMsg = await ebayRes.json();
            console.log(`✅ eBayスレッド作成成功! ID=${ebayMsg.channel_id}`);
            console.log(`   → .env に追加: DISCORD_EBAY_THREAD_ID=${ebayMsg.channel_id}\n`);
            console.log('===================================');
            console.log('✅ フォーラムスレッド方式で完了!');
            console.log('   .envファイルに以下を追加してください:');
            console.log(`   DISCORD_SNKRDUNK_THREAD_ID=${msg.channel_id}`);
            console.log(`   DISCORD_EBAY_THREAD_ID=${ebayMsg.channel_id}`);
            console.log('===================================');
            return;
        }
    }

    // フォーラム方式が失敗 → テキストチャンネルの場合
    console.log('⚠️ フォーラムチャンネルではないため、thread_name方式は使えません');
    console.log('\n📋 代替方法:');
    console.log('   1. Discordサーバーで対象チャンネルを右クリック');
    console.log('   2.「チャンネルの設定」→「チャンネルの種類」→「フォーラム」に変更');
    console.log('   3. このスクリプトを再実行');
    console.log('\n   または:');
    console.log('   1. 2つの別々のWebhookを作成');
    console.log('   2. .envに DISCORD_SNKRDUNK_WEBHOOK と DISCORD_EBAY_WEBHOOK を設定');
}

main().catch(err => {
    console.error('❌ エラー:', err);
    process.exit(1);
});
