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
            signOptions: { expiresIn: config.jwtExpiresIn },
        }),
    ],
    controllers: [AuthController],
    providers: [AuthService, JwtAuthGuard, ProtocolAuthorityGuard],
    exports: [JwtModule, JwtAuthGuard, ProtocolAuthorityGuard],
})
export class AuthModule {}
