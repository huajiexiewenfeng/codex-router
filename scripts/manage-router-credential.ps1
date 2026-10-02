$ErrorActionPreference = 'Stop'
$credentialLock = $null
$credentialTemp = $null
$credentialSecure = $null
try {
    Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
    Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
    $credentialRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $credentialPath = [IO.Path]::GetFullPath($credentialRequest.filePath)
    $credentialLockPath = $credentialPath + '.credential.lock'
    try { $credentialLock = [IO.File]::Open($credentialLockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { if ([IO.File]::Exists($credentialLockPath)) { throw 'RC_LOCKED' }; throw }
    $credentialExists = [IO.File]::Exists($credentialPath)
    if ($credentialRequest.operation -eq 'create' -and $credentialExists) { throw 'RC_EXISTS' }
    $credentialUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($credentialRequest.operation -ne 'create') {
        if (-not $credentialExists) { throw 'RC_CONFLICT' }
        if (([IO.File]::GetAttributes($credentialPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RC_PERMISSIONS' }
        $credentialAcl = [IO.File]::GetAccessControl($credentialPath)
        if ($credentialAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $credentialUser.Value -or -not $credentialAcl.AreAccessRulesProtected) { throw 'RC_PERMISSIONS' }
        foreach ($credentialRule in $credentialAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($credentialRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $credentialRule.IdentityReference.Value -notin @($credentialUser.Value, 'S-1-5-18')) { throw 'RC_PERMISSIONS' }
        }
        $credentialHasher = [Security.Cryptography.SHA256]::Create()
        try { $credentialHash = [BitConverter]::ToString($credentialHasher.ComputeHash([IO.File]::ReadAllBytes($credentialPath))).Replace('-', '').ToLowerInvariant() } finally { $credentialHasher.Dispose() }
        if ($credentialHash -cne $credentialRequest.expectedSha256) { throw 'RC_CONFLICT' }
    }
    if ($credentialRequest.operation -eq 'delete') {
        [IO.File]::Delete($credentialPath)
        [Console]::Out.Write('{"status":"deleted"}')
    } else {
        $credentialSecure = ConvertTo-SecureString -String $credentialRequest.secret -AsPlainText -Force
        $credentialCipher = ConvertFrom-SecureString $credentialSecure
        $credentialBytes = [Text.Encoding]::UTF8.GetBytes($credentialCipher)
        $credentialTemp = $credentialPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
        $credentialAcl = New-Object Security.AccessControl.FileSecurity
        $credentialAcl.SetAccessRuleProtection($true, $false)
        $credentialAcl.SetOwner($credentialUser)
        foreach ($credentialSid in @($credentialUser, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
            $credentialRule = New-Object Security.AccessControl.FileSystemAccessRule($credentialSid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
            $credentialAcl.AddAccessRule($credentialRule)
        }
        $credentialStream = New-Object IO.FileStream($credentialTemp, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $credentialAcl)
        try { $credentialStream.Write($credentialBytes, 0, $credentialBytes.Length); $credentialStream.Flush($true) } finally { $credentialStream.Dispose() }
        if ($credentialRequest.operation -eq 'create') { [IO.File]::Move($credentialTemp, $credentialPath); $credentialStatus = 'created' }
        else { [IO.File]::Replace($credentialTemp, $credentialPath, [NullString]::Value); $credentialStatus = 'replaced' }
        $credentialTemp = $null
        $credentialHasher = [Security.Cryptography.SHA256]::Create()
        try { $credentialHash = [BitConverter]::ToString($credentialHasher.ComputeHash($credentialBytes)).Replace('-', '').ToLowerInvariant() } finally { $credentialHasher.Dispose() }
        [Console]::Out.Write((@{status=$credentialStatus;sha256=$credentialHash;permissions='current-user-and-system'} | ConvertTo-Json -Compress))
    }
} catch {
    $credentialCode = $_.Exception.Message
    if ($credentialCode -notin @('RC_EXISTS','RC_CONFLICT','RC_LOCKED','RC_PERMISSIONS')) { $credentialCode = 'RC_UNAVAILABLE' }
    [Console]::Error.Write($credentialCode)
    exit 1
} finally {
    if ($null -ne $credentialSecure) { $credentialSecure.Dispose() }
    if ($null -ne $credentialTemp -and [IO.File]::Exists($credentialTemp)) { [IO.File]::Delete($credentialTemp) }
    if ($null -ne $credentialLock) { $credentialLock.Dispose(); [IO.File]::Delete($credentialLockPath) }
}
