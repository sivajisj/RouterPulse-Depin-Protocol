import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { ProtocolAuthorityGuard } from "./guards/protocol-authority.guard";
import { config } from "../config";

@Module({
    imports: [
        JwtModule.register({
            secret: config.jwtSecret,
            // Cast: @nestjs/jwt 11 types `expiresIn` as `number |
            // StringValue` (ms's template-literal union like "1h"), which
            // an env-var string can't satisfy statically. The value is
            // still validated at runtime by jsonwebtoken — a malformed
            // duration throws on the first token signed, at startup.
            signOptions: { expiresIn: config.jwtExpiresIn as any },
        }),
    ],
    controllers: [AuthController],
    providers: [AuthService, JwtAuthGuard, ProtocolAuthorityGuard],
    exports: [JwtModule, JwtAuthGuard, ProtocolAuthorityGuard],
})
export class AuthModule {}
