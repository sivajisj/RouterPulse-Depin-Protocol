import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Db } from "mongodb";
import { MONGO_DB } from "../../database/database.module";

/// RBAC tied directly to on-chain state, not a role stored in this
/// API's own database: the caller's session wallet (set by
/// JwtAuthGuard, which must run first) has to match whatever wallet is
/// *currently* the protocol's on-chain authority. If the real authority
/// rotates — a multisig migration, an emergency key change — access
/// here follows automatically on the next reconcile pass, with nothing
/// to update in this service.
@Injectable()
export class ProtocolAuthorityGuard implements CanActivate {
    constructor(@Inject(MONGO_DB) private readonly db: Db) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const wallet: string | undefined = request.user?.wallet;
        if (!wallet) throw new ForbiddenException("No authenticated wallet on this request");

        const protocol = await this.db.collection("protocol").findOne({ _id: "protocol" as any });
        if (!protocol) throw new ForbiddenException("Protocol not yet indexed");

        if (protocol.authority !== wallet) {
            throw new ForbiddenException("This wallet is not the current protocol authority");
        }
        return true;
    }
}
