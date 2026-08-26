import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ProtocolService } from "./protocol.service";

@ApiTags("protocol")
@Controller("api/v1/protocol")
export class ProtocolController {
    constructor(private readonly protocol: ProtocolService) {}

    @Get()
    @ApiOperation({ summary: "Global protocol config + cumulative stats (reconciled from the real on-chain account)" })
    get() {
        return this.protocol.get();
    }

    @Get("epochs/current")
    @ApiOperation({ summary: "The current epoch number and time remaining in it" })
    currentEpoch() {
        return this.protocol.currentEpoch();
    }
}
