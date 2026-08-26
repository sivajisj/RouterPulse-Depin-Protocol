import { Body, Controller, Get, Post, Query, BadRequestException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { AuthService } from "./auth.service";

@ApiTags("auth")
@Controller("api/v1/auth")
export class AuthController {
    constructor(private readonly auth: AuthService) {}

    @Get("challenge")
    @ApiOperation({ summary: "Step 1 of Sign-In-With-Solana: get a message for this wallet to sign" })
    challenge(@Query("wallet") wallet?: string) {
        if (!wallet) throw new BadRequestException("wallet query param is required");
        return this.auth.issueChallenge(wallet);
    }

    @Post("verify")
    @ApiOperation({ summary: "Step 2: submit the signature over the challenge message to receive a session JWT" })
    verify(@Body() body: { wallet?: string; signature?: string }) {
        if (!body.wallet || !body.signature) {
            throw new BadRequestException("wallet and signature (base58) are both required");
        }
        return this.auth.verify(body.wallet, body.signature);
    }
}
