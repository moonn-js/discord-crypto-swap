export class HealthState {
  constructor() {
    this.database = false;
    this.discord = false;
    this.assets = false;
    this.oneClickAuthentication = true;
  }

  isReady() {
    return this.database && this.discord && this.assets && this.oneClickAuthentication;
  }

  snapshot() {
    return {
      ready: this.isReady(),
      checks: {
        database: this.database,
        discord: this.discord,
        assets: this.assets,
        oneClickAuthentication: this.oneClickAuthentication,
      },
    };
  }
}
