interface ApiOptions {
  baseUrl: string;
  token: string;
}

export class ApiClient {
  private baseUrl: string;
  private token: string;

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
  }

  private async request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  async createDevice(routerId: string, name: string, region: string) {
    return this.request("POST", "/v1/devices", {
      router_id: routerId,
      name,
      region,
    });
  }

  async listDevices() {
    return this.request("GET", "/v1/devices");
  }

  async submitTelemetry(payload: {
    device_id: string;
    sequence_num: number;
    latency_ms: number;
    packet_loss_pct: number;
    download_mbps: number;
    upload_mbps: number;
    availability: boolean;
    nonce: string;
    signature?: string;
  }) {
    return this.request("POST", "/v1/telemetry/heartbeat", payload);
  }
}
