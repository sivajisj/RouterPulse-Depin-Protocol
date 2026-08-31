"use client";

import { useMemo } from "react";
import { AnchorProvider, Program, BN } from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import idl from "./idl/routerpulse.json";

export { BN };

// PDA helpers live in a framework-free module so they can also be
// imported by headless verification scripts — see pdas.ts.
export {
    PROGRAM_ID, protocolPda, rewardMintPda, stakeVaultPda, treasuryPda,
    routerPda, stakePda, routerEpochPda, vestingPda, emissionPda,
} from "./pdas";

export function useProgram(): Program | null {
    const { connection } = useConnection();
    const wallet = useWallet();

    return useMemo(() => {
        if (!wallet.publicKey || !wallet.signTransaction) return null;
        const provider = new AnchorProvider(
            connection,
            wallet as any,
            { commitment: "confirmed" }
        );
        return new Program(idl as any, provider);
    }, [connection, wallet.publicKey, wallet.signTransaction]);
}
