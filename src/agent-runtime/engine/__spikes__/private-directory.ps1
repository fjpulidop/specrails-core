param(
  [Parameter(Mandatory=$true)][string]$Target,
  [ValidateSet('protect', 'inspect')][string]$Mode = 'inspect'
)
$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($Mode -eq 'protect') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($sid in @($identity.User, (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')))) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $propagation, 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Target -AclObject $acl
}
$actual = Get-Acl -LiteralPath $Target
$entries = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; access = $_.AccessControlType.ToString(); inherited = $_.IsInherited; rights = $_.FileSystemRights.ToString() }
})
@{
  ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  currentUserSid = $identity.User.Value
  protected = $actual.AreAccessRulesProtected
  entries = $entries
} | ConvertTo-Json -Depth 4 -Compress
