$ErrorActionPreference = 'Stop'
$credentialBuffer = [IntPtr]::Zero
$credentialSecure = $null
try {
    Import-Module "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
    $credentialCiphertext = [Console]::In.ReadToEnd()
    $credentialSecure = ConvertTo-SecureString -String $credentialCiphertext -ErrorAction Stop
    $credentialBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credentialSecure)
    [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($credentialBuffer))
} catch {
    [Console]::Error.Write('RC_DECRYPT_FAILED')
    exit 1
} finally {
    if ($credentialBuffer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($credentialBuffer)
    }
    if ($null -ne $credentialSecure) { $credentialSecure.Dispose() }
}
