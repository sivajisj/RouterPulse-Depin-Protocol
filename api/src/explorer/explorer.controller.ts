import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ExplorerService } from "./explorer.service";

@ApiTags("explorer")
@Controller("api/v1")
export class ExplorerController {
    constructor(private readonly explorer: ExplorerService) {}

    @Get("transactions/:signature")
    @ApiOperation({ summary: "One transaction's indexed metadata plus every event it emitted" })
    getTransaction(@Param("signature") signature: string) {
        return this.explorer.getTransaction(signature);
    }

    @Get("events")
    @ApiOperation({ summary: "Raw decoded event feed, newest first, optionally filtered by event name" })
    listEvents(
        @Query("name") name?: string,
        @Query("cursor") cursor?: string,
        @Query("limit") limit?: string,
    ) {
        return this.explorer.listEvents({ name, cursor, limit: limit ? Number(limit) : undefined });
    }
}
