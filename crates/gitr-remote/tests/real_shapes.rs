use gitr_remote::{LinkTarget, link, parse};

/// The shape of the Azure DevOps remotes in everyday use (org name as the HTTPS user name).
#[test]
fn everyday_ado_remote_shapes_produce_working_links() {
    for url in [
        "https://Contoso@dev.azure.com/Contoso/Atlas/_git/Atlas.Backend",
        "https://dev.azure.com/Contoso/Atlas/_git/Atlas.Tracer",
    ] {
        let info = parse(url).unwrap_or_else(|| panic!("not parsed: {url}"));
        assert_eq!(info.web_url.split("/_git/").next().unwrap(), "https://dev.azure.com/Contoso/Atlas");
        assert!(!info.web_url.contains('@'), "credentials must never reach the browser link: {}", info.web_url);
        let branch = "Atlas/Feature/AB-2891";
        assert_eq!(link(&info, &LinkTarget::Repo), info.web_url);
        assert!(link(&info, &LinkTarget::Branch { branch: branch.into() }).ends_with("?version=GBAtlas/Feature/AB-2891"));
        assert!(link(&info, &LinkTarget::PullRequest { branch: branch.into(), target: None }).ends_with("/pullrequestcreate?sourceRef=Atlas/Feature/AB-2891"));
        // A branch name with characters that need escaping still yields one well-formed URL.
        let odd = link(&info, &LinkTarget::Branch { branch: "feat/a b&c#d?e".into() });
        assert!(!odd.contains(' ') && !odd.contains('#') && odd.matches('?').count() == 1, "{odd}");
    }
}
