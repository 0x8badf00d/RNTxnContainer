import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import KioskCore

/// Opaque-box configuration, model, and deterministic JWT/OAuth payload factory
/// strictly conforming to `PROJECT.md § Interface Contracts`.
public enum E2EConfigFactory: Sendable {
    // MARK: - Canonical PRD Defaults

    public static let defaultIssuerURL = URL(string: "https://auth.kiosk.example.com")!
    public static let defaultAuthorizationEndpoint = URL(string: "https://auth.kiosk.example.com/as/authorization.oauth2")!
    public static let defaultTokenEndpoint = URL(string: "https://auth.kiosk.example.com/as/token.oauth2")!
    public static let defaultRevocationEndpoint = URL(string: "https://auth.kiosk.example.com/as/revoke_token.oauth2")!
    public static let defaultClientId = "pos-kiosk-ios-client"
    public static let defaultRedirectURI = URL(string: "kiosk-pos-ios://oauth/callback")!
    public static let defaultScopes: [String] = ["openid", "profile", "pos.transactions"]

    public static let defaultStatusEndpointURL = URL(string: "https://timeclock.kiosk.example.com/api/v1/shift/status")!
    public static let sampleDeviceBindEndpointURL = URL(string: "https://timeclock.kiosk.example.com/api/v1/device/bind")!

    public static let defaultAllowedInternalDomains: Set<String> = [
        "api.internal.kiosk.example.com",
        "pos.internal.kiosk.example.com",
    ]

    public static let defaultAllowedPublicAssetDomains: Set<String> = [
        "cdn.public.kiosk.example.com",
        "images.public.kiosk.example.com",
    ]

    public static let defaultPollIntervalMs: Int64 = 300_000
    public static let defaultOfflineLogoutThresholdMs: Int64 = 900_000
    public static let defaultMaxDrainDurationMs: Int64 = 300_000
    public static let defaultDebounceWindowMs: Int64 = 2_000
    public static let defaultNetworkRetryDelayMs: Int64 = 5_000
    public static let defaultProactiveRefreshBufferSec: Int64 = 30
    public static let defaultMaxRetryBodyBytes: Int = 1_048_576
    public static let defaultHardIdleTimeoutMs: Int64 = 60_000
    public static let defaultScreenReaderMultiplier: Double = 2.5
    public static let defaultMaxHoldDurationMs: Int64 = 90_000
    public static let defaultCrashCircuitBreakerCount: Int = 3
    public static let defaultCrashCircuitBreakerWindowMs: Int64 = 30_000
    public static let defaultHealthyResetDurationMs: Int64 = 60_000

    // MARK: - Composable Config Builders

    public static func makePFedConfig(
        issuerUrl: URL = defaultIssuerURL,
        authorizationEndpoint: URL = defaultAuthorizationEndpoint,
        tokenEndpoint: URL = defaultTokenEndpoint,
        revocationEndpoint: URL = defaultRevocationEndpoint,
        clientId: String = defaultClientId,
        redirectUri: URL = defaultRedirectURI,
        scopes: [String] = defaultScopes,
        additionalAllowedAuthHosts: [String] = []
    ) -> KioskHostConfig.PFedConfig {
        KioskHostConfig.PFedConfig(
            issuerUrl: issuerUrl,
            authorizationEndpoint: authorizationEndpoint,
            tokenEndpoint: tokenEndpoint,
            revocationEndpoint: revocationEndpoint,
            clientId: clientId,
            redirectUri: redirectUri,
            scopes: scopes,
            additionalAllowedAuthHosts: additionalAllowedAuthHosts
        )
    }

    public static func makeTimeclockConfig(
        statusEndpointUrl: URL = defaultStatusEndpointURL,
        deviceBindEndpointUrl: URL? = nil,
        pollIntervalMs: Int64 = defaultPollIntervalMs,
        offlineLogoutThresholdMs: Int64 = defaultOfflineLogoutThresholdMs,
        maxDrainDurationMs: Int64 = defaultMaxDrainDurationMs,
        debounceWindowMs: Int64 = defaultDebounceWindowMs,
        networkRetryDelayMs: Int64 = defaultNetworkRetryDelayMs
    ) -> KioskHostConfig.TimeclockConfig {
        KioskHostConfig.TimeclockConfig(
            statusEndpointUrl: statusEndpointUrl,
            deviceBindEndpointUrl: deviceBindEndpointUrl,
            pollIntervalMs: pollIntervalMs,
            offlineLogoutThresholdMs: offlineLogoutThresholdMs,
            maxDrainDurationMs: maxDrainDurationMs,
            debounceWindowMs: debounceWindowMs,
            networkRetryDelayMs: networkRetryDelayMs
        )
    }

    public static func makeNetworkConfig(
        allowedInternalDomains: Set<String> = defaultAllowedInternalDomains,
        allowedPublicAssetDomains: Set<String> = defaultAllowedPublicAssetDomains,
        proactiveRefreshBufferSec: Int64 = defaultProactiveRefreshBufferSec,
        maxRetryBodyBytes: Int = defaultMaxRetryBodyBytes
    ) -> KioskHostConfig.NetworkConfig {
        KioskHostConfig.NetworkConfig(
            allowedInternalDomains: allowedInternalDomains,
            allowedPublicAssetDomains: allowedPublicAssetDomains,
            proactiveRefreshBufferSec: proactiveRefreshBufferSec,
            maxRetryBodyBytes: maxRetryBodyBytes
        )
    }

    public static func makeCustomerSessionConfig(
        hardIdleTimeoutMs: Int64 = defaultHardIdleTimeoutMs,
        screenReaderMultiplier: Double = defaultScreenReaderMultiplier,
        maxHoldDurationMs: Int64 = defaultMaxHoldDurationMs,
        crashCircuitBreakerCount: Int = defaultCrashCircuitBreakerCount,
        crashCircuitBreakerWindowMs: Int64 = defaultCrashCircuitBreakerWindowMs,
        healthyResetDurationMs: Int64 = defaultHealthyResetDurationMs
    ) -> KioskHostConfig.CustomerSessionConfig {
        KioskHostConfig.CustomerSessionConfig(
            hardIdleTimeoutMs: hardIdleTimeoutMs,
            screenReaderMultiplier: screenReaderMultiplier,
            maxHoldDurationMs: maxHoldDurationMs,
            crashCircuitBreakerCount: crashCircuitBreakerCount,
            crashCircuitBreakerWindowMs: crashCircuitBreakerWindowMs,
            healthyResetDurationMs: healthyResetDurationMs
        )
    }

    public static func makeDeviceConfig(
        storeId: String = "STORE-0042",
        kioskId: String = "KIOSK-07",
        terminalId: String = "TERM-0042-07",
        environment: KioskDeviceConfig.Environment = .prod
    ) -> KioskDeviceConfig {
        KioskDeviceConfig(
            storeId: storeId,
            kioskId: kioskId,
            terminalId: terminalId,
            environment: environment
        )
    }

    public static func makeConfig(
        pfed: KioskHostConfig.PFedConfig = makePFedConfig(),
        timeclock: KioskHostConfig.TimeclockConfig = makeTimeclockConfig(),
        network: KioskHostConfig.NetworkConfig = makeNetworkConfig(),
        customerSession: KioskHostConfig.CustomerSessionConfig = makeCustomerSessionConfig(),
        device: KioskDeviceConfig = makeDeviceConfig(),
        onHostMetric: KioskHostMetricHandler? = nil
    ) -> KioskHostConfig {
        KioskHostConfig(
            pfed: pfed,
            timeclock: timeclock,
            network: network,
            customerSession: customerSession,
            device: device,
            onHostMetric: onHostMetric
        )
    }

    // MARK: - Model Builders

    public static func makeAssociateProfile(
        associateId: String = "assoc-10042",
        displayName: String = "Alex Rivera",
        roles: [String] = ["CASHIER", "POS_OPERATOR"],
        permissions: [String] = ["pos.checkout", "pos.void", "pos.refund.limited"],
        storeId: String = "STORE-0042"
    ) -> AssociateProfile {
        AssociateProfile(
            associateId: associateId,
            displayName: displayName,
            roles: roles,
            permissions: permissions,
            storeId: storeId
        )
    }

    public static func makeOAuthTokens(
        accessToken: String? = nil,
        refreshToken: String? = "e2e-refresh-token-v1",
        idToken: String? = nil,
        expiresAtMonotonicMs: Int64 = 1_300_000,
        scope: String? = "openid profile pos.transactions",
        profile: AssociateProfile = makeAssociateProfile()
    ) -> OAuthTokens {
        let resolvedAccess = accessToken ?? makeAccessTokenJWT(
            subject: profile.associateId,
            storeId: profile.storeId
        )
        let resolvedId = idToken ?? makeAssociateIDToken(profile: profile)
        return OAuthTokens(
            accessToken: resolvedAccess,
            refreshToken: refreshToken,
            idToken: resolvedId,
            expiresAtMonotonicMs: expiresAtMonotonicMs,
            scope: scope
        )
    }

    // MARK: - Deterministic Base64URL JWT & OAuth JSON Helpers

    public static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func makeJWT(
        header: [String: Any] = ["alg": "RS256", "typ": "JWT"],
        payload: [String: Any],
        signature: String = "e2e-deterministic-signature"
    ) -> String {
        let headerData = try! JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
        let payloadData = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let sigData = Data(signature.utf8)
        return "\(base64URLEncode(headerData)).\(base64URLEncode(payloadData)).\(base64URLEncode(sigData))"
    }

    public static func makeAssociateIDToken(
        profile: AssociateProfile = makeAssociateProfile(),
        issuer: String = "https://auth.kiosk.example.com",
        audience: String = defaultClientId,
        issuedAtEpochSec: Int64 = 1_700_000_000,
        expiresAtEpochSec: Int64 = 1_700_003_600,
        extraClaims: [String: Any] = [:]
    ) -> String {
        var claims: [String: Any] = [
            "iss": issuer,
            "aud": audience,
            "sub": profile.associateId,
            "name": profile.displayName,
            "roles": profile.roles,
            "permissions": profile.permissions,
            "store_id": profile.storeId,
            "iat": issuedAtEpochSec,
            "exp": expiresAtEpochSec,
        ]
        for (key, value) in extraClaims {
            claims[key] = value
        }
        return makeJWT(payload: claims)
    }

    public static func makeAccessTokenJWT(
        subject: String = "assoc-10042",
        storeId: String = "STORE-0042",
        scopes: [String] = defaultScopes,
        tokenVersion: Int = 1
    ) -> String {
        let claims: [String: Any] = [
            "iss": "https://auth.kiosk.example.com",
            "aud": defaultClientId,
            "sub": subject,
            "store_id": storeId,
            "scope": scopes.joined(separator: " "),
            "jti": "e2e-tok-v\(tokenVersion)",
            "iat": 1_700_000_000,
            "exp": 1_700_003_600,
        ]
        return makeJWT(payload: claims, signature: "e2e-access-sig-v\(tokenVersion)")
    }

    public static func makeTokenEndpointPayloadData(
        accessToken: String,
        refreshToken: String? = "e2e-refresh-token-v1",
        idToken: String? = nil,
        expiresInSec: Int = 300,
        tokenType: String = "Bearer",
        scope: String = "openid profile pos.transactions"
    ) -> Data {
        var body: [String: Any] = [
            "access_token": accessToken,
            "token_type": tokenType,
            "expires_in": expiresInSec,
            "scope": scope,
        ]
        if let refreshToken {
            body["refresh_token"] = refreshToken
        }
        if let idToken {
            body["id_token"] = idToken
        }
        return try! JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }
}
