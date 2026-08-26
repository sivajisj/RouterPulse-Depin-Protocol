import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { config } from "./config";

export async function createApp() {
    const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });

    app.enableCors({ origin: config.corsOrigins, credentials: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    const swagger = new DocumentBuilder()
        .setTitle("RouterPulse API")
        .setDescription(
            "Read API over the RouterPulse indexer's MongoDB projection of on-chain state. " +
            "Solana is the source of truth; this serves the indexed projection of it."
        )
        .setVersion("1.0")
        .addBearerAuth()
        .build();
    SwaggerModule.setup("api/docs", app, SwaggerModule.createDocument(app, swagger));

    return app;
}

async function bootstrap() {
    const app = await createApp();
    await app.listen(config.port);
    Logger.log(`RouterPulse API listening on :${config.port} (docs at /api/docs)`, "Bootstrap");
}

if (require.main === module) {
    bootstrap().catch(err => {
        console.error("Fatal:", err);
        process.exit(1);
    });
}
