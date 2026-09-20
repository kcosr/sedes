export type SshEnvironmentAvailabilityObservation =
  | Readonly<{ readonly availability: "available" }>
  | Readonly<{
      readonly availability: "unavailable";
      readonly diagnosticCode: string;
    }>;

export interface SshBackendAvailabilityReporter {
  reportBackendObservation(
    backendInstanceId: string,
    observation: SshEnvironmentAvailabilityObservation,
  ): Promise<void>;
}

/**
 * Serializes and combines independent reachability evidence for one SSH
 * execution environment. A positive observation from any current source wins;
 * negative observations matter only when no source is currently positive.
 */
export class SshEnvironmentAvailabilityAggregator implements SshBackendAvailabilityReporter {
  readonly #configurationRevision: number;
  readonly #activeConfigurationRevision: () => number | Promise<number>;
  readonly #reportAvailability: (
    available: boolean,
    diagnosticCode?: string,
  ) => void | Promise<void>;
  readonly #observations = new Map<
    string,
    SshEnvironmentAvailabilityObservation
  >();
  #publicationTail: Promise<void> = Promise.resolve();

  constructor(input: {
    readonly configurationRevision: number;
    readonly activeConfigurationRevision: () => number | Promise<number>;
    readonly reportAvailability: (
      available: boolean,
      diagnosticCode?: string,
    ) => void | Promise<void>;
  }) {
    if (
      !Number.isSafeInteger(input.configurationRevision) ||
      input.configurationRevision < 0
    ) {
      throw new Error("ssh_environment_availability_configuration_invalid");
    }
    this.#configurationRevision = input.configurationRevision;
    this.#activeConfigurationRevision = input.activeConfigurationRevision;
    this.#reportAvailability = input.reportAvailability;
  }

  reportBackendObservation(
    backendInstanceId: string,
    observation: SshEnvironmentAvailabilityObservation,
  ): Promise<void> {
    if (!backendInstanceId) {
      return Promise.reject(
        new Error("ssh_environment_availability_source_invalid"),
      );
    }
    return this.#enqueue(`backend:${backendInstanceId}`, observation);
  }

  reportSidecarObservation(
    observation: SshEnvironmentAvailabilityObservation,
  ): Promise<void> {
    return this.#enqueue("sidecar", observation);
  }

  #enqueue(
    source: string,
    observation: SshEnvironmentAvailabilityObservation,
  ): Promise<void> {
    const publication = this.#publicationTail.then(async () => {
      if (!(await this.#isCurrentRevision())) return;
      this.#observations.set(source, observation);
      const available = [...this.#observations.values()].some(
        (candidate) => candidate.availability === "available",
      );
      if (!(await this.#isCurrentRevision())) return;
      await this.#reportAvailability(
        available,
        available || observation.availability === "available"
          ? undefined
          : observation.diagnosticCode,
      );
    });
    this.#publicationTail = publication.catch(() => undefined);
    return publication;
  }

  async #isCurrentRevision(): Promise<boolean> {
    return (
      (await this.#activeConfigurationRevision()) ===
      this.#configurationRevision
    );
  }
}
