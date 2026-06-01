# RouterPulse

A Solana DePIN protocol for trustless Wi-Fi router uptime
tracking and reward distribution.
Inspired by real-world Wi-Fi infrastructure networks.

## Stack
- Solana + Anchor + Rust (on-chain)
- Node.js + TypeScript (router simulator)
- Localnet → Devnet

## Quick Start
anchor build
anchor test

## Architecture
Router Simulator → Heartbeat → Anchor Program → PDA → Uptime Score → Rewards
export PATH="/home/codespace/.local/share/solana/install/active_release/bin:$PATH"
