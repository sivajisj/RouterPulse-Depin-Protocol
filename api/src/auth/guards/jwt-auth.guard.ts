import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

/// Attaches `request.user = { wallet }` when the request carries a
/// valid session JWT (see AuthService). Routes needing only "someone
/// signed in" use this alone; routes needing a *specific* signed-in
/// wallet stack ProtocolAuthorityGuard on top of it.
@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(private readonly jwt: JwtService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const header: string | undefined = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) {
            throw new UnauthorizedException("Missing Authorization: Bearer <token> header");
        }

        try {
            request.user = await this.jwt.verifyAsync(header.slice("Bearer ".length));
            return true;
        } catch {
            throw new UnauthorizedException("Invalid or expired session token");
        }
    }
}
