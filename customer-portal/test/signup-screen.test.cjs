'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {screen,policy,welcome}=require('../web/auth.js');
test('closed signup remains discoverable without accepting credentials or silently becoming login',()=>{
  assert.match(screen({signup:false,config:{signupEnabled:false}}),/href="#signup"/);
  const closed=screen({signup:true,config:{signupEnabled:false,signupMessage:'가입 점검 중'}});
  assert.match(closed,/가입 점검 중/);assert.doesNotMatch(closed,/id="auth-form"/);assert.match(closed,/href="#login"/);
});
test('signup has explicit business choice and unchecked required consents; text is escaped',()=>{
  const html=screen({signup:true,config:{signupEnabled:true,termsUrl:'/terms',privacyUrl:'/privacy',usernameCheckEnabled:true}});
  for(const name of ['username','password','passwordConfirm','phone','email','businessStatus','agreeTerms','agreePrivacy','confirmAge'])assert.match(html,new RegExp(`name="${name}"`));
  assert.doesNotMatch(html,/\schecked(?:\s|>)/);assert.match(html,/autocomplete="new-password"/);assert.match(html,/중복 확인/);
  assert.doesNotMatch(policy({title:'<script>bad</script>',version:'v1',sections:[]},{},false),/<script>/);
  assert.match(welcome({username:'<unsafe>',businessStatus:'owned',entitlements:{competitorLimit:3}}),/내 매장 찾기/);
  assert.match(welcome({username:'planning',businessStatus:'planning',entitlements:{competitorLimit:3}}),/관심지역 선택/);
});
