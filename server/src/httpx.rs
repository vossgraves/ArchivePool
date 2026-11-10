use futures_util::StreamExt;
use reqwest::{
    Method,
    dns::{Addrs, Name, Resolve, Resolving},
    header::{HeaderMap, HeaderName, HeaderValue},
};
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;
use url::Url;
pub const DEFAULT_UA: &str = "ArchiveTune-SourcePool/1.0";
pub const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug, Clone, Copy)]
pub enum Error {
    Blocked,
    Network,
    Timeout,
    TooLarge,
    Redirect,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Blocked => "outbound address is not public",
            Self::Network => "fetch failed",
            Self::Timeout => "timeout",
            Self::TooLarge => "response exceeds size limit",
            Self::Redirect => "invalid redirect",
        })
    }
}
impl std::error::Error for Error {}
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && b == 168
                || a == 100 && (64..=127).contains(&b)
                || a == 192 && b == 0
                || a == 192 && b == 2
                || a == 192 && b == 88 && c == 99
                || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113
                || v.octets() == [168, 63, 129, 16])
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let s = v.segments();
            s[0] & 0xe000 == 0x2000
                && !(s[0] == 0x2001
                    && (s[1] == 0
                        || s[1] == 2
                        || s[1] == 0xdb8
                        || s[1] & 0xfff0 == 0x0010
                        || s[1] & 0xfff0 == 0x0020))
                && s[0] != 0x2002
        }
    }
}
#[derive(Clone, Default)]
struct PublicResolver {
    allowed: HashSet<IpAddr>,
}
impl PublicResolver {
    fn permits(&self, ip: IpAddr) -> bool {
        is_public(ip) || self.allowed.contains(&ip)
    }
}
impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.clone();
        Box::pin(async move {
            let addresses: Vec<SocketAddr> =
                tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if addresses.is_empty() || addresses.iter().any(|a| !policy.permits(a.ip())) {
                return Err(Box::new(Error::Blocked) as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}
#[derive(Clone)]
pub struct Outbound {
    client: reqwest::Client,
    policy: PublicResolver,
    slots: Arc<Semaphore>,
}
pub struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Vec<u8>,
}
impl Response {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
    }
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}
impl Outbound {
    pub fn new() -> Result<Self, Error> {
        Self::build(PublicResolver::default())
    }
    fn build(policy: PublicResolver) -> Result<Self, Error> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(policy.clone()))
            .connect_timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(2)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent(DEFAULT_UA)
            .build()
            .map_err(|_| Error::Network)?;
        Ok(Self {
            client,
            policy,
            slots: Arc::new(Semaphore::new(6)),
        })
    }
    #[cfg(test)]
    pub fn local() -> Self {
        Self::build(PublicResolver {
            allowed: ["127.0.0.1".parse().unwrap(), "::1".parse().unwrap()]
                .into_iter()
                .collect(),
        })
        .unwrap()
    }
    fn check_url(&self, url: &Url) -> Result<(), Error> {
        if !["http", "https"].contains(&url.scheme())
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Blocked);
        }
        let host = url
            .host_str()
            .ok_or(Error::Blocked)?
            .trim_matches(['[', ']']);
        if host
            .parse::<IpAddr>()
            .is_ok_and(|ip| !self.policy.permits(ip))
        {
            return Err(Error::Blocked);
        }
        Ok(())
    }
    pub async fn send(
        &self,
        method: Method,
        raw: &str,
        mut headers: HeaderMap,
        mut body: Vec<u8>,
    ) -> Result<Response, Error> {
        tokio::time::timeout(Duration::from_secs(12), async {
            let _slot = self.slots.acquire().await.map_err(|_| Error::Network)?;
            let mut url = Url::parse(raw).map_err(|_| Error::Blocked)?;
            let mut method = method;
            for hop in 0..=10 {
                self.check_url(&url)?;
                let response = self
                    .client
                    .request(method.clone(), url.clone())
                    .headers(headers.clone())
                    .body(body.clone())
                    .send()
                    .await
                    .map_err(|e| {
                        if e.is_timeout() {
                            Error::Timeout
                        } else {
                            Error::Network
                        }
                    })?;
                let status = response.status().as_u16();
                if [301, 302, 303, 307, 308].contains(&status) {
                    if let Some(location) = response.headers().get("location") {
                        if hop == 10 {
                            return Err(Error::Redirect);
                        }
                        let next = url
                            .join(location.to_str().map_err(|_| Error::Redirect)?)
                            .map_err(|_| Error::Redirect)?;
                        self.check_url(&next)?;
                        if next.origin() != url.origin() {
                            strip_credentials(&mut headers);
                            body.clear();
                        }
                        if status == 303 && method != Method::HEAD
                            || [301, 302].contains(&status) && method == Method::POST
                        {
                            method = Method::GET;
                            body.clear();
                            headers.remove("content-type");
                        }
                        url = next;
                        continue;
                    }
                }
                let headers = response.headers().clone();
                if response
                    .content_length()
                    .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
                {
                    return Err(Error::TooLarge);
                }
                let mut body = Vec::new();
                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk.map_err(|_| Error::Network)?;
                    if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
                        return Err(Error::TooLarge);
                    }
                    body.extend_from_slice(&chunk);
                }
                return Ok(Response {
                    status,
                    headers,
                    body,
                });
            }
            Err(Error::Redirect)
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
    pub async fn get(&self, url: &str, headers: HeaderMap) -> Result<Response, Error> {
        self.send(Method::GET, url, headers, vec![]).await
    }
    pub async fn form(
        &self,
        url: &str,
        mut headers: HeaderMap,
        form: &[(&str, String)],
    ) -> Result<Response, Error> {
        headers.insert(
            "content-type",
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        let bytes = {
            let mut encoded = url::form_urlencoded::Serializer::new(String::new());
            for (k, v) in form {
                encoded.append_pair(k, v);
            }
            encoded.finish().into_bytes()
        };
        self.send(Method::POST, url, headers, bytes).await
    }
}
pub fn headers(entries: &[(&str, &str)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in entries {
        if let (Ok(k), Ok(v)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            h.insert(k, v);
        }
    }
    h
}
pub fn strip_credentials(headers: &mut HeaderMap) {
    let keep: HeaderMap = headers
        .iter()
        .filter(|(k, _)| matches!(k.as_str(), "accept" | "accept-encoding" | "user-agent"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    *headers = keep;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_private_and_metadata_ipv4_ipv6() {
        for raw in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "100.100.100.200",
            "168.63.129.16",
            "224.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "2001:db8::1",
            "2002:7f00:1::1",
            "64:ff9b::7f00:1",
        ] {
            assert!(!is_public(raw.parse().unwrap()), "{raw}");
        }
        for raw in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public(raw.parse().unwrap()));
        }
    }
    #[tokio::test]
    async fn rejects_literal_and_resolved_loopback() {
        let client = Outbound::new().unwrap();
        for url in [
            "http://127.0.0.1/",
            "http://[::1]/",
            "http://localhost/",
            "http://user:password@8.8.8.8/",
        ] {
            assert!(client.get(url, HeaderMap::new()).await.is_err());
        }
    }
    #[test]
    fn redirect_removes_all_custom_credentials() {
        let mut h = headers(&[
            ("authorization", "secret"),
            ("cookie", "secret"),
            ("x-user-auth-token", "secret"),
            ("x-app-id", "secret"),
            ("media-user-token", "secret"),
            ("accept", "application/json"),
        ]);
        strip_credentials(&mut h);
        assert_eq!(h.len(), 1);
        assert!(h.contains_key("accept"));
    }
}
