import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Db } from "mongodb";
import { Inject } from "@nestjs/common";
import { MONGO_DB } from "../database/database.module";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { ProtocolAuthorityGuard } from "../auth/guards/protocol-authority.guard";

@ApiTags("admin")
@ApiBearerAuth()
@Controller("api/v1/admin")
@UseGuards(JwtAuthGuard, ProtocolAuthorityGuard)
export class AdminController {
    constructor(@Inject(MONGO_DB) private readonly db: Db) {}

    @Get("audit")
    @ApiOperation({
        summary: "Full unfiltered event feed for governance-relevant actions",
        description:
            "Gated to whichever wallet is currently the on-chain protocol authority (see ProtocolAuthorityGuard). " +
            "Everything here is technically public on-chain data, same as /api/v1/events — the point of gating it " +
            "is to demonstrate wallet-signature RBAC tied to live on-chain state, the pattern real admin panels need.",
    })
    async audit(@Query("limit") limit?: string) {
        const n = Math.min(Number(limit) || 50, 200);
        return this.db.collection("events")
            .find({ name: { $in: [
                // economic actions
                "PenaltyApplied", "RouterSlashed", "TreasuryBurned", "GenesisMinted",
                // governance actions — who changed what, and when
                "ProtocolPaused", "ProtocolResumed", "RouterReinstated",
                "RouterDecommissioned", "RewardRateUpdated",
            ] } })
            .sort({ blockTime: -1 })
            .limit(n)
            .toArray();
    }
}
