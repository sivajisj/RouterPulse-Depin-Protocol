#!/bin/bash
set -e

echo "🚀 Deploying RouterPulse to Devnet..."

# switch to devnet
solana config set --url devnet
echo "✅ Switched to devnet"

# check balance (integer SOL only — no bc needed)
BALANCE=$(solana balance | awk '{print int($1)}')
echo "💰 Current balance: $BALANCE SOL"

# airdrop if below 2 SOL
if [ "$BALANCE" -lt 2 ]; then
    echo "⚡ Balance low — requesting airdrop..."
    solana airdrop 2 || {
        echo "⚠️  Airdrop failed (devnet faucet rate-limited)."
        echo "   Fund manually: https://faucet.solana.com"
        echo "   Wallet: $(solana address)"
        exit 1
    }
    sleep 5
    NEW_BALANCE=$(solana balance | awk '{print int($1)}')
    echo "💰 Balance after airdrop: $NEW_BALANCE SOL"
fi

# build
echo "🔨 Building..."
anchor build

# deploy
echo "📦 Deploying..."
anchor program deploy --provider.cluster devnet

echo ""
echo "✅ Deployed to Devnet!"
PROGRAM_ID=$(solana address -k target/deploy/routerpulse-keypair.json)
echo "   Program ID: $PROGRAM_ID"
echo "   Explorer:   https://explorer.solana.com/address/$PROGRAM_ID?cluster=devnet"
