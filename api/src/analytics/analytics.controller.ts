import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";

@ApiTags("analytics")
@Controller("api/v1/analytics")
export class AnalyticsController {
    constructor(private readonly analytics: AnalyticsService) {}

    @Get("network")
    @ApiOperation({ summary: "Network-wide snapshot: router counts by status, average uptime, total staked" })
    network() {
        return this.analytics.network();
    }

    @Get("regions")
    @ApiOperation({ summary: "Router count and average uptime grouped by coarse lat/long region" })
    regions() {
        return this.analytics.byRegion();
    }

    @Get("epochs")
    @ApiOperation({ summary: "Most recently finalized epochs across all routers" })
    epochs(@Query("limit") limit?: string) {
        return this.analytics.epochPerformance(limit ? Number(limit) : undefined);
    }
}
