import type {
  ApplicationPreferences,
  UpdateApplicationPreferencesRequest,
} from "../../shared/protocol/application-preferences.js";
import type { PrincipalApplicationPreferenceRepository } from "../db/repositories/principal-application-preference-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";

export class PrincipalApplicationPreferenceService {
  constructor(
    readonly input: {
      readonly repository: PrincipalApplicationPreferenceRepository;
      readonly now?: () => number;
    },
  ) {}

  read(scope: RequestScope): ApplicationPreferences {
    return this.input.repository.read(scope);
  }

  update(
    scope: RequestScope,
    input: UpdateApplicationPreferencesRequest,
  ): ApplicationPreferences {
    return this.input.repository.update(scope, {
      ...input,
      now: this.input.now?.() ?? Date.now(),
    });
  }
}
