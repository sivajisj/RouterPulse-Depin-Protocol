import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { RoutersService } from "./routers.service";

@ApiTags("routers")
@Controller("api/v1/routers")
export class RoutersController {
    constructor(private readonly routers: RoutersService) {}

    @Get()
    @ApiOperation({ summary: "List indexed routers, optionally filtered by status/owner" })
    list(
        @Query("status") status?: string,
        @Query("owner") owner?: string,
        @Query("cursor") cursor?: string,
        @Query("limit") limit?: string,
    ) {
        return this.routers.list({ status, owner, cursor, limit: limit ? Number(limit) : undefined });
    }

    @Get(":routerPda")
    @ApiOperation({ summary: "Fetch one router's current indexed state by its PDA address" })
    getOne(@Param("routerPda") routerPda: string) {
        return this.routers.getOne(routerPda);
    }

    @Get(":routerPda/epochs")
    @ApiOperation({ summary: "Epoch history for a router, newest first" })
    epochs(
        @Param("routerPda") routerPda: string,
        @Query("cursor") cursor?: string,
        @Query("limit") limit?: string,
    ) {
        return this.routers.epochs(routerPda, { cursor, limit: limit ? Number(limit) : undefined });
    }

    @Get(":routerPda/heartbeats")
    @ApiOperation({ summary: "Most recent raw heartbeat events for a router" })
    heartbeats(@Param("routerPda") routerPda: string, @Query("limit") limit?: string) {
        return this.routers.recentHeartbeats(routerPda, limit ? Number(limit) : undefined);
    }
}
