#!/bin/bash
set -e

echo "🚀 Deploying RouterPulse to Devnet..."

# switch to devnet
solana config set --url devnet
echo "✅ Switched to devnet"

# check balance
BALANCE=$(solana balance | awk '{print $1}')
echo "💰 Current balance: $BALANCE SOL"

# airdrop if low
if (( $(echo "$BALANCE < 2" | bc -l) )); then
    echo "⚡ Airdropping SOL..."
    solana airdrop 2
    sleep 3
fi

# build
echo "🔨 Building..."
anchor build

# deploy
echo "📦 Deploying..."
anchor deploy --provider.cluster devnet

echo ""
echo "✅ Deployed to Devnet!"
echo "   Program ID: $(solana address -k target/deploy/routerpulse-keypair.json)"
echo "   Explorer:   https://explorer.solana.com/address/$(solana address -k target/deploy/routerpulse-keypair.json)?cluster=devnet"
